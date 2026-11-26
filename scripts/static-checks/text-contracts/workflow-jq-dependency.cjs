'use strict';

// #2589 and #1854: config-get, resolve-model, resolve-execution, verification.status and update-context lookups in
// the audited workflows must not pipe to jq (on a jq-less host the stage fails, the failure is swallowed and the value
// is silently dropped), ship.md decides the verification gate on a single status read (the two message fields come
// after the blocking prose), review.md still declares jq a prerequisite for the lanes that need it, no workflow cites
// review.md by line number, and update.md still resolves the four update-context fields. The pipe detectors are
// linear scans that read every pipe of the line (the old patterns stopped at the first, so a tr stage before jq evaded them). The audited
// files are all read (a missing one is a finding, where the test skipped it). Was tests/workflow-jq-dependency.test.cjs.

const WF = 'gsd-core/workflows';
const AUDITED = ['review.md', 'plan-phase.md', 'ship.md', 'debug.md', 'autonomous.md', 'ai-integration-phase.md', 'eval-review.md', 'update.md'];

const LANES_MARKER = 'jq-dependent reviewer lanes';
const FAMILIES = ['config-get', 'resolve-model', 'verification.status', 'resolve-execution'];
const isWord = (ch) => ch !== undefined && /\w/.test(ch);

// True when, on the line that holds `from`, a pipe (not the `||` operator) is followed by `jq`: any stage of the pipeline,
// whitespace (a newline included) allowed after the pipe.
function pipesToJq(text, from) {
  let at = from;
  while (at < text.length && text[at] !== '\n') {
    if (text[at] !== '|') {
      at += 1;
      continue;
    }
    if (text[at + 1] === '|') {
      at += 2;
      continue;
    }
    let next = at + 1;
    while (next < text.length && /\s/.test(text[next])) next += 1;
    if (text.startsWith('jq', next) && !isWord(text[next + 2])) return true;
    at += 1;
  }
  return false;
}

// True when some occurrence of `word` (followed by a word boundary) is piped to jq.
function wordPipedToJq(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const end = at + word.length;
    if (!isWord(text[end]) && pipesToJq(text, end)) return true;
  }
  return false;
}

// True when `gsd_run query <family> ... | jq` appears: whitespace between the words, then one of the query families.
// With `onlyUncovered` a hit counts only when the family is not followed by a word boundary: the family probes already
// see the others, so the general guard reports the one pipe no family probe sees.
function queryPipedToJq(text, onlyUncovered = false) {
  const families = FAMILIES;
  for (let at = text.indexOf('gsd_run'); at !== -1; at = text.indexOf('gsd_run', at + 1)) {
    let next = at + 'gsd_run'.length;
    const blanks = (from) => {
      let end = from;
      while (end < text.length && /\s/.test(text[end])) end += 1;
      return end;
    };
    if (blanks(next) === next) continue;
    next = blanks(next);
    if (!text.startsWith('query', next)) continue;
    next += 'query'.length;
    if (blanks(next) === next) continue;
    next = blanks(next);
    for (const family of families) {
      if (!text.startsWith(family, next)) continue;
      const end = next + family.length;
      if (family === 'verification.status' && isWord(text[end])) continue;
      if (onlyUncovered && !isWord(text[end])) continue;
      if (pipesToJq(text, end)) return true;
    }
  }
  return false;
}

// True when `<call> <whitespace> <field>` appears with a word boundary after the field.
function callsWithField(text, call, field) {
  for (let at = text.indexOf(call); at !== -1; at = text.indexOf(call, at + 1)) {
    let next = at + call.length;
    const start = next;
    while (next < text.length && /\s/.test(text[next])) next += 1;
    if (next > start && text.startsWith(field, next) && !isWord(text[next + field.length])) return true;
  }
  return false;
}

// True when `lane` appears as a whole word after the first mention of the jq-dependent lanes.
function laneAfterDeclaration(text, lane) {
  const from = text.indexOf(LANES_MARKER);
  if (from === -1) return true; // the missing declaration is reported once by its own assertion
  const base = from + LANES_MARKER.length;
  for (let at = text.indexOf(lane, base); at !== -1; at = text.indexOf(lane, at + 1)) {
    if (!isWord(text[at - 1]) && !isWord(text[at + lane.length])) return true;
  }
  return false;
}

module.exports = {
  id: 'workflow-jq-dependency',
  issue: '#2589',
  walkers: { wordPipedToJq, queryPipedToJq, callsWithField, laneAfterDeclaration },
  check(ctx) {
    // One document per path: a file that is gone, or empty, is one finding however many assertions read it.
    const docs = new Map();
    const docOf = (rel) => {
      if (!docs.has(rel)) docs.set(rel, ctx.doc(rel));
      return docs.get(rel);
    };
    const familyWhy = {
      'config-get': 'config-get lookups must use --raw, not a jq pipe',
      'resolve-model': 'resolve-model lookups must use --pick, not a jq pipe',
      'verification.status': 'verification.status lookups must use --pick, not a jq pipe',
      'resolve-execution': 'resolve-execution lookups must use --pick, not a jq pipe (sibling of resolve-model)',
    };
    const probes = [
      ...FAMILIES.map((family) => [familyWhy[family], (text) => wordPipedToJq(text, family)]),
      // The general guard reports only a query family written with no word boundary: a pipe a family probe sees is reported once.
      ['no gsd_run query (config-get|resolve-model|resolve-execution|verification.status) may pipe to jq',
        (text) => queryPipedToJq(text, true)],
      ['update-context lookups must not pipe to jq (#1854)', (text) => wordPipedToJq(text, 'update-context')],
    ];
    for (const name of AUDITED) {
      const doc = docOf(`${WF}/${name}`);
      for (const [why, piped] of probes) doc.satisfies((text) => !piped(text) || 'a pipe to jq is present', why);
    }

    docOf(`${WF}/ship.md`).satisfies((text) => {
      const statusAt = text.indexOf('STATUS=$(gsd_run query verification.status');
      if (statusAt === -1) return 'ship.md must read verification.status --pick status';
      const prefix = 'gsd_run query verification.status "${PHASE_DIR}" --pick ';
      let picks = 0;
      for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
        if (isWord(text[at + prefix.length])) picks += 1;
      }
      if (picks !== 3) return `ship.md should read status once plus the two message fields, found ${picks}`;
      const blockAt = text.indexOf('PHASE_VERIFICATION_INCOMPLETE');
      if (!(blockAt > statusAt)) return 'the block decision must follow the status read';
      for (const field of ['next_action', 'next_command']) {
        const at = text.indexOf(`--pick ${field}`);
        if (at === -1) return `ship.md must still surface ${field}`;
        if (!(at > blockAt)) return `${field} must be read only on the blocking path, not before the gate decides`;
      }
      return true;
    }, 'ship.md must decide the verification gate on a single verification.status read');

    const review = docOf(`${WF}/review.md`)
      .has(LANES_MARKER, 'review.md must declare the jq-dependent reviewer lanes')
      .has('command -v jq >/dev/null 2>&1 && echo "jq:available" || echo "jq:missing"', 'review.md detect_clis must probe jq alongside the other reviewer prerequisites');
    for (const lane of ['ollama', 'lm_studio', 'llama_cpp', 'opencode', 'antigravity']) {
      review.satisfies((text) => laneAfterDeclaration(text, lane), `review.md must name ${lane} as a jq-dependent lane`);
    }

    // Cross-references to review.md go by section name, in every workflow directly under the directory.
    const top = ctx.list(WF, '.md', 'the workflows hold the review.md cross-references').filter((rel) => rel.split('/').length === WF.split('/').length + 1);
    for (const rel of top) docOf(rel).lacks(/review\.md:\d/, `${rel} must cite review.md by section name, not a line number`);

    const update = docOf(`${WF}/update.md`);
    for (const field of ['installedVersion', 'scope', 'runtime', 'gsdDir']) {
      update.satisfies((text) => callsWithField(text, 'uc_field', field), `update.md must still resolve ${field} from the update-context projection`);
    }
  },
};
