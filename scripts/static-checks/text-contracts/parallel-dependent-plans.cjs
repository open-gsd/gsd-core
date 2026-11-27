'use strict';

// Bug #1587 (dependent plans must not run in parallel) and #3761 (the same-wave overlap gate is anchored, not a whole-file
// substring): gsd-planner.md's assign_waves step references files_modified and the overlap, and carries a normative
// `**Rule:**` paragraph in which ONE sentence holds all four clauses of the gate (a wave scope, the files_modified subject, a
// prohibition and an overlap predicate); execute-phase.md has a pre-spawn intra-wave files_modified overlap check that comes
// before the "Spawn executor agents" heading and, between the two, warns, runs the plans sequentially and covers every plan
// pair. Dropped: the assign_waves "references files_modified" assertion (the rule's own sentence implies it), the cases of
// helpers defined inside the old test (the gate's teeth are rows of the real step instead) and the extractStepBody round trip
// (the engine's slice is the owner). Was tests/parallel-dependent-plans.test.cjs.

const { asciiLower } = require('./lib/ascii-lower.cjs');
const { hasWordRun } = require('./lib/bounded-walks.cjs');

const PLANNER = 'agents/gsd-planner.md';
const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';
const STEP_OPEN = '<step name="assign_waves">';
const SPAWN_HEADING = 'Spawn executor agents';
const WS = /\s/;
const PROHIBITIONS = ['zero', 'no', 'not', 'never'];
const OVERLAP_WORDS = ['overlap', 'share', 'sharing', 'conflict', 'touch'];
const COVERAGE_PHRASES = ['all plans in', 'all plans within', 'each pair', 'any two plans'];

// The four clauses that make the rule a same-wave overlap GATE: each takes the ASCII-lower-cased sentence and the sentence.
const CLAUSES = [
  ['wave scope', (lower) => hasWordRun(lower, ['wave'])],
  ['files_modified subject', (lower, sentence) => sentence.includes('files_modified')],
  ['prohibition', (lower) => hasWordRun(lower, PROHIBITIONS)],
  ['overlap predicate', (lower) => OVERLAP_WORDS.some((word) => lower.includes(word))],
];

// The `**Rule:**` paragraph of a step body: the marker line and every continuation line up to the next blank line, trimmed and
// joined with a space; null when no line starts with the marker.
function ruleParagraph(body) {
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.trimStart().startsWith('**Rule:**'));
  if (first === -1) return null;
  const paragraph = [];
  for (let i = first; i < lines.length && lines[i].trim() !== ''; i += 1) paragraph.push(lines[i].trim());
  return paragraph.join(' ');
}

// The sentences of a paragraph: split where a run of whitespace follows a full stop or a semicolon, blank ones dropped.
function ruleSentences(paragraph) {
  const sentences = [];
  let from = 0;
  for (let at = 1; at < paragraph.length; at += 1) {
    if ((paragraph[at - 1] !== '.' && paragraph[at - 1] !== ';') || !WS.test(paragraph[at])) continue;
    sentences.push(paragraph.slice(from, at));
    while (at < paragraph.length && WS.test(paragraph[at])) at += 1;
    from = at;
  }
  sentences.push(paragraph.slice(from));
  return sentences.filter((sentence) => sentence.trim() !== '');
}

// The names of the clauses the closest sentence of the rule paragraph fails; empty when one sentence holds all four.
function missingRuleClauses(body) {
  const paragraph = ruleParagraph(body);
  if (paragraph === null) return ['**Rule:** paragraph'];
  let closest = CLAUSES.map(([name]) => name);
  for (const sentence of ruleSentences(paragraph)) {
    const lower = asciiLower(sentence);
    const missing = CLAUSES.filter(([, holds]) => !holds(lower, sentence)).map(([name]) => name);
    if (missing.length < closest.length) closest = missing;
    if (closest.length === 0) break;
  }
  return closest;
}

// The overlap check's marker (the first `intra-wave`, else the first `files_modified overlap`) and the spawn heading, in order:
// the text between them, or the reason there is none.
function overlapRegion(text) {
  const marker = text.includes('intra-wave') ? text.indexOf('intra-wave') : text.indexOf('files_modified overlap');
  const spawn = text.indexOf(SPAWN_HEADING);
  if (marker === -1) return { missing: 'marker' };
  if (spawn === -1) return { error: `the "${SPAWN_HEADING}" heading is missing` };
  if (marker >= spawn) return { error: `the overlap check (at ${marker}) comes after the "${SPAWN_HEADING}" heading (at ${spawn})` };
  return { text: text.slice(marker, spawn) };
}

// An assertion over the region between the overlap check and the spawn: a missing marker is the whole-file assertion's finding and
// a missing or misplaced heading is the order assertion's, so the region assertions then pass.
const inRegion = (predicate) => (text) => {
  const region = overlapRegion(text);
  return region.text === undefined ? true : predicate(region.text);
};

module.exports = {
  walkers: { ruleParagraph, ruleSentences, missingRuleClauses, overlapRegion },
  id: 'parallel-dependent-plans',
  issue: '#1587',
  check(ctx) {
    const planner = ctx.doc(PLANNER);
    planner
      .has('files_modified', 'the planner must reference files_modified')
      .satisfies((text) => !text.includes('files_modified') || text.includes('files_modified overlap') || text.includes('later wave') || 'neither "files_modified overlap" nor "later wave" is present',
        'the planner must explicitly require a later wave when files_modified overlap exists');
    planner.slice(STEP_OPEN, '</step>')
      .satisfies((text) => text.includes('overlap') || text.includes('shared file') || 'neither "overlap" nor "shared file" is present',
        'the assign_waves step must handle file overlap as a wave-bumping condition')
      .satisfies((text) => {
        const missing = missingRuleClauses(text.slice(STEP_OPEN.length));
        return missing.length === 0 || `missing: ${missing.join(', ')}`;
      }, 'the assign_waves step must carry a normative **Rule:** paragraph whose one sentence states that same-wave plans have zero files_modified overlap');

    ctx.doc(EXECUTE_PHASE)
      .satisfies((text) => {
        const missing = [];
        if (!text.includes('files_modified')) missing.push('files_modified');
        if (!text.includes('overlap') && !text.includes('intra-wave')) missing.push('overlap or intra-wave');
        return missing.length === 0 || `missing: ${missing.join(', ')}`;
      }, 'the workflow must check for files_modified overlap within a wave before spawning')
      .satisfies((text) => {
        const region = overlapRegion(text);
        if (region.missing === 'marker') {
          // An absent overlap text is the whole-file assertion's finding; only a present-but-unmarked check is this one's.
          return !text.includes('files_modified') || (!text.includes('overlap') && !text.includes('intra-wave')) || 'neither "intra-wave" nor "files_modified overlap" is present';
        }
        return region.error === undefined || region.error;
      }, 'the overlap check must appear before the "Spawn executor agents" section')
      .satisfies(inRegion((region) => region.includes('sequential') || 'no "sequential" in the overlap check'),
        'the workflow must direct sequential execution when overlap is detected')
      .satisfies(inRegion((region) => {
        const missing = [];
        if (!region.includes('overlap')) missing.push('overlap');
        if (!asciiLower(region).includes('warn')) missing.push('warn');
        return missing.length === 0 || `missing: ${missing.join(', ')}`;
      }), 'the workflow must log a warning when files_modified overlap is detected in a wave')
      .satisfies(inRegion((region) => COVERAGE_PHRASES.some((phrase) => region.includes(phrase)) || 'none of the four phrases is in the overlap check'),
        'the overlap check must cover every plan pair in the wave, not just adjacent ones');
  },
};
