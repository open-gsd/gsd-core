'use strict';

// #2589 and #1854: config-get, resolve-model, resolve-execution, verification.status and update-context lookups in
// the audited workflows must not pipe to jq (on a jq-less host the stage fails, the failure is swallowed and the value
// is silently dropped), ship.md decides the verification gate on a single status read (the two message fields come
// after the blocking prose), review.md still declares jq a prerequisite for the lanes that need it, no workflow cites
// review.md by line number, and update.md still resolves the four update-context fields. The pipe detectors are
// linear scans that stop at the first pipe of the line, as the old patterns did, so no gap evades them. The audited
// files are all read (a missing one is a finding, where the test skipped it). Was tests/workflow-jq-dependency.test.cjs.

const WF = 'gsd-core/workflows';
const AUDITED = ['review.md', 'plan-phase.md', 'ship.md', 'debug.md', 'autonomous.md', 'ai-integration-phase.md', 'eval-review.md', 'update.md'];

const isWord = (ch) => ch !== undefined && /\w/.test(ch);

// True when the text from `from` runs to a pipe on its own line and `jq` follows the pipe (whitespace in between).
function pipesToJq(text, from) {
  let at = from;
  while (at < text.length && text[at] !== '|' && text[at] !== '\n') at += 1;
  if (text[at] !== '|') return false;
  at += 1;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return text.startsWith('jq', at) && !isWord(text[at + 2]);
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
function queryPipedToJq(text) {
  const families = ['config-get', 'resolve-model', 'resolve-execution', 'verification.status'];
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
  const marker = 'jq-dependent reviewer lanes';
  const from = text.indexOf(marker);
  if (from === -1) return false;
  const tail = text.slice(from + marker.length);
  for (let at = tail.indexOf(lane); at !== -1; at = tail.indexOf(lane, at + 1)) {
    if (!isWord(tail[at - 1]) && !isWord(tail[at + lane.length])) return true;
  }
  return false;
}

module.exports = {
  id: 'workflow-jq-dependency',
  issue: '#2589',
  check(ctx) {
    const probes = [
      ['config-get lookups must use --raw, not a jq pipe', (text) => wordPipedToJq(text, 'config-get')],
      ['resolve-model lookups must use --pick, not a jq pipe', (text) => wordPipedToJq(text, 'resolve-model')],
      ['verification.status lookups must use --pick, not a jq pipe', (text) => wordPipedToJq(text, 'verification.status')],
      ['no gsd_run query (config-get|resolve-model|resolve-execution|verification.status) may pipe to jq', queryPipedToJq],
      ['update-context lookups must not pipe to jq (#1854)', (text) => wordPipedToJq(text, 'update-context')],
      ['resolve-execution lookups must use --pick, not a jq pipe (sibling of resolve-model)', (text) => wordPipedToJq(text, 'resolve-execution')],
    ];
    for (const name of AUDITED) {
      const doc = ctx.doc(`${WF}/${name}`);
      for (const [why, piped] of probes) doc.satisfies((text) => !piped(text) || 'a pipe to jq is present', why);
    }

    ctx.doc(`${WF}/ship.md`).satisfies((text) => {
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

    const review = ctx.doc(`${WF}/review.md`)
      .has('command -v jq >/dev/null 2>&1 && echo "jq:available" || echo "jq:missing"', 'review.md detect_clis must probe jq alongside the other reviewer prerequisites');
    for (const lane of ['ollama', 'lm_studio', 'llama_cpp', 'opencode', 'antigravity']) {
      review.satisfies((text) => laneAfterDeclaration(text, lane), `review.md must name ${lane} as a jq-dependent lane`);
    }

    // Cross-references to review.md go by section name, in every workflow directly under the directory.
    const top = ctx.list(WF, '.md', 'the workflows hold the review.md cross-references').filter((rel) => rel.split('/').length === WF.split('/').length + 1);
    for (const rel of top) ctx.doc(rel).lacks(/review\.md:\d/, `${rel} must cite review.md by section name, not a line number`);

    const update = ctx.doc(`${WF}/update.md`);
    for (const field of ['installedVersion', 'scope', 'runtime', 'gsdDir']) {
      update.satisfies((text) => callsWithField(text, 'uc_field', field), `update.md must still resolve ${field} from the update-context projection`);
    }
  },
};
