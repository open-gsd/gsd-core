'use strict';

// The /gsd:update workflow and command (#498, #815, #2470, #3130, #4153): an unresolved update target exits before any
// mutating step; the latest-version parse is Node-only with a false default; the backup step takes RUNTIME_DIR from
// GSD_DIR (no LOCAL_DIR/GLOBAL_DIR) and gates detect-custom-files on it; --next/--rc selects the @next tag through the
// check and the two install lines (never a hardcoded dist-tag); no bare ~/.claude path and no bare `npx -y @opengsd/...`
// form; the PREFERRED_RUNTIME prose lists the same runtime -> dir pairs as RUNTIME_DIRS (read from the shipped
// update-context module). The old regexes with a dot, a negated class or a `\s+` are linear walks with the same stop
// characters. The old test asserted the plain @latest install literal and then the @latest|next|beta|canary|rc
// alternation in run_update: the alternation implies the first, so one assertion remains. Was
// tests/update-workflow.test.cjs (its #815, #2470 and #3130 blocks were folded in).

const path = require('node:path');
const { loadLib } = require('./lib/load-lib.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { precedesWithin } = require('./lib/precedes-within.cjs');

const WORKFLOW = 'gsd-core/workflows/update.md';
const COMMAND = 'commands/gsd/update.md';
const SECTIONIZER = 'gsd-core/bin/lib/markdown-sectionizer.cjs';
const UPDATE_CONTEXT = 'gsd-core/bin/lib/update-context.cjs';
const REAL_ROOT = path.join(__dirname, '..', '..', '..');
const WS = /\s/;
const INFER_MARKER = 'Infer `PREFERRED_RUNTIME` from the path';
const ROBUST_PREFIX = 'npx -y --package=@opengsd/gsd-core@';
const ROBUST_SUFFIX = ' -- gsd-core';
const TAGGED_INSTALL = 'npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core';
const STALE_PREFIX = 'npx -y @opengsd/gsd-core@';
const CAPTURE_HEAD = 'if LATEST_RESULT="$(node ';
const CAPTURE_TAIL = ')"; then';
const CAPTURE_PARTS = ['LATEST_STATUS=0', 'else', 'LATEST_STATUS=$?', 'fi'];
const SPIES = [
  ['version check', 'check-latest-version.cjs'],
  ['custom-file detection', 'detect-custom-files --config-dir'],
  ['resolved installer', 'npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core "$RUNTIME_FLAG"'],
  ['update-cache removal', 'rm -f "$HOME/.cache/gsd/gsd-update-check"'],
  ['restore apply', 'restore-custom-files --config-dir "$GSD_DIR" --apply'],
  ['patch check', 'check_local_patches'],
];

const isWord = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

// `word` with no word character on either side: the walk of /\bword\b/.
function hasWord(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!isWord(text[at - 1]) && !isWord(text[at + word.length])) return true;
  }
  return false;
}

// `uc_field()`, optional whitespace, then `{`: the walk of /uc_field\(\)\s*\{/.
function definesUcField(text) {
  for (let at = text.indexOf('uc_field()'); at !== -1; at = text.indexOf('uc_field()', at + 1)) {
    let pos = at + 'uc_field()'.length;
    while (pos < text.length && WS.test(text[pos])) pos += 1;
    if (text[pos] === '{') return true;
  }
  return false;
}

// After `pos`: one or more whitespace characters, then `part`; the index after `part`, or -1.
function afterSpaced(text, pos, part) {
  let at = pos;
  while (at < text.length && WS.test(text[at])) at += 1;
  if (at === pos || !text.startsWith(part, at)) return -1;
  return at + part.length;
}

// /if LATEST_RESULT="\$\(node [^\n]+\)"; then\s+LATEST_STATUS=0\s+else\s+LATEST_STATUS=\$\?\s+fi/ as a walk: the head
// opens a line, the tail literal follows on the same line after at least one character, then the whitespace chain.
function capturesLatestStatus(text) {
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const head = line.indexOf(CAPTURE_HEAD);
    if (head !== -1) {
      for (let tail = line.indexOf(CAPTURE_TAIL, head + CAPTURE_HEAD.length + 1); tail !== -1; tail = line.indexOf(CAPTURE_TAIL, tail + 1)) {
        let pos = lineStart + tail + CAPTURE_TAIL.length;
        for (const part of CAPTURE_PARTS) pos = pos === -1 ? -1 : afterSpaced(text, pos, part);
        if (pos !== -1) return true;
      }
    }
    lineStart = lineEnd + 1;
  }
  return false;
}

// Every `~/.claude` or `$HOME/.claude` not followed by `/`: the matches of /(?:~|\$HOME)\/\.claude(?!\/)/g.
function bareClaudePaths(text) {
  const found = [];
  for (let at = 0; at < text.length; at += 1) {
    const literal = ['~/.claude', '$HOME/.claude'].find((candidate) => text.startsWith(candidate, at));
    if (literal === undefined) continue;
    const end = at + literal.length;
    if (text[end] === '/') continue;
    found.push(literal);
    at = end - 1;
  }
  return found;
}

// Every `npx -y @opengsd/gsd-core@` followed by a non-blank character, through the end of its line: the matches of
// /npx -y @opengsd\/gsd-core@\S+[^\r\n]*/g (the stale cache-prone install form).
function staleNpxForms(text) {
  const found = [];
  for (let at = text.indexOf(STALE_PREFIX); at !== -1; at = text.indexOf(STALE_PREFIX, at + 1)) {
    const from = at + STALE_PREFIX.length;
    if (from >= text.length || WS.test(text[from])) continue;
    let end = from;
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1;
    found.push(text.slice(at, end));
    at = end - 1;
  }
  return found;
}

// How many times /npx -y --package=@opengsd\/gsd-core@\S+ -- gsd-core/ matches: the prefix, a run of non-blank characters,
// then a space and the suffix.
function robustInstalls(text) {
  let count = 0;
  for (let at = text.indexOf(ROBUST_PREFIX); at !== -1; at = text.indexOf(ROBUST_PREFIX, at + 1)) {
    const from = at + ROBUST_PREFIX.length;
    let end = from;
    while (end < text.length && !WS.test(text[end])) end += 1;
    if (end > from && text.startsWith(ROBUST_SUFFIX, end)) {
      count += 1;
      at = end + ROBUST_SUFFIX.length - 1;
    }
  }
  return count;
}

// How many times the literal `needle` occurs, without overlap.
function countOf(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

// The `/dir/` tokens (backticked, with a non-empty dir) of a clause: the captures of /`\/([^`]+)\/`/g.
function slashDirs(text) {
  const dirs = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] === '`' && text[at + 1] === '/') {
      const close = text.indexOf('`', at + 2);
      if (close !== -1 && close >= at + 4 && text[close - 1] === '/') {
        dirs.push(text.slice(at + 2, close - 1));
        at = close + 1;
        continue;
      }
    }
    at += 1;
  }
  return dirs;
}

// The first backticked run of lowercase letters: the capture of /`([a-z]+)`/, or undefined.
function tickedWord(text) {
  for (let at = text.indexOf('`'); at !== -1; at = text.indexOf('`', at + 1)) {
    let end = at + 1;
    while (end < text.length && text[end] >= 'a' && text[end] <= 'z') end += 1;
    if (end > at + 1 && text[end] === '`') return text.slice(at + 1, end);
  }
  return undefined;
}

// The runtime:dir pairs a PREFERRED_RUNTIME inference line states, or the clause that names no runtime.
function docPairsOf(line) {
  const pairs = new Set();
  for (const clause of line.split(';')) {
    const arrow = clause.indexOf('->');
    if (arrow === -1) continue;
    const dirs = slashDirs(clause.slice(0, arrow));
    const runtime = tickedWord(clause.slice(arrow + 2));
    if (!runtime) return { error: `clause must name a runtime: ${clause}` };
    for (const dir of dirs) pairs.add(`${runtime}:${dir}`);
  }
  return { pairs };
}

// true when the doc line and RUNTIME_DIRS list the same runtime -> dir pairs, else the difference.
function parityProblems(line, runtimeDirs) {
  const doc = docPairsOf(line);
  if (doc.error) return doc.error;
  if (!Array.isArray(runtimeDirs) || !runtimeDirs.every((entry) => Array.isArray(entry) && entry.length >= 2)) {
    return 'RUNTIME_DIRS is not a list of [runtime, dir] entries';
  }
  const table = new Set(runtimeDirs.map(([runtime, dir]) => `${runtime}:${dir}`));
  const onlyDoc = [...doc.pairs].filter((pair) => !table.has(pair)).sort();
  const onlyTable = [...table].filter((pair) => !doc.pairs.has(pair)).sort();
  if (onlyDoc.length === 0 && onlyTable.length === 0) return true;
  return `only in the prose: ${JSON.stringify(onlyDoc)}; only in RUNTIME_DIRS: ${JSON.stringify(onlyTable)}`;
}

// The first index of `first` precedes the first index of `second`; a missing `first` is reported elsewhere.
const ordered = (first, second) => (text) => {
  const at = text.indexOf(first);
  if (at === -1) return true;
  const next = text.indexOf(second);
  return (next !== -1 && at < next) || `${JSON.stringify(second)} must follow ${JSON.stringify(first)}`;
};

// The PREFERRED_RUNTIME inference line of a text, or undefined.
const inferenceLineOf = (text) => text.split('\n').find((candidate) => candidate.includes(INFER_MARKER));

// A check of the inference line that holds when the line is missing: its absence is reported once, by the parity check.
const whenInferred = (holds) => (text) => {
  const line = inferenceLineOf(text);
  return line === undefined || holds(line);
};

// The text after the end of the get_installed_version step, or undefined when the step has no end.
function afterInstalledStep(text) {
  const start = text.indexOf('<step name="get_installed_version">');
  const end = start === -1 ? -1 : text.indexOf('</step>', start);
  return end === -1 ? undefined : text.slice(end);
}

// The spy needles that the text after the step lacks.
const missingAfter = (tail) => SPIES.filter(([, needle]) => !tail.includes(needle));

function buildCheck({ loadSectionizer, loadUpdateContext }) {
  return function check(ctx) {
    const sectionizer = loadLib(loadSectionizer, SECTIONIZER);
    const updateContext = loadLib(loadUpdateContext, UPDATE_CONTEXT);
    if (sectionizer.error) ctx.fail(WORKFLOW, sectionizer.error);
    if (updateContext.error) ctx.fail(WORKFLOW, updateContext.error);

    const update = ctx.doc(WORKFLOW);
    const installed = update.step('get_installed_version');
    installed
      .has('UPDATE_TARGET_UNRESOLVED', 'the unresolved target must have a typed result')
      .has('TARGET_RUNTIME=""', 'the unresolved fallback must empty TARGET_RUNTIME')
      .has('GSD_DIR=""', 'the unresolved fallback must empty GSD_DIR')
      .satisfies(whenInferred((line) => /otherwise leave (?:it )?empty/.test(line)), 'an unrecognized execution_context path must not infer Claude')
      .satisfies(whenInferred((line) => line.includes('`/.claude/` -> `claude`')), 'the PREFERRED_RUNTIME inference must map /.claude/ to claude')
      .satisfies(whenInferred((line) => line.includes('`/.windsurf/`, `/.devin/` -> `windsurf`')), 'the PREFERRED_RUNTIME inference must map /.windsurf/ and /.devin/ to windsurf')
      .lacks(/otherwise `?claude`?\./, 'the inference must not fall back to claude for an unrecognized path')
      .has('INSTALL_SCOPE` is `UNKNOWN`, `TARGET_RUNTIME` is empty, or `GSD_DIR` is empty', 'the unresolved gate must name its three conditions')
      .has(/rerun from a valid installed runtime/i, 'the unresolved result must tell the user to rerun from a valid installed runtime')
      .has('Rerun from a valid installed runtime: `/gsd:update`.', 'the unresolved block must carry the rerun instruction')
      .has('npx -y --package=@opengsd/gsd-core@latest -- gsd-core --global', 'the unresolved block must offer the fresh-install command')
      .has('target runtime (`claude`, `opencode`, `kilo`, `codex`, `antigravity`, `windsurf`)', 'the output contract must list the target runtimes')
      .satisfies((text) => {
        const at = text.indexOf('UPDATE_TARGET_UNRESOLVED');
        return at === -1 || text.indexOf('Exit.', at) !== -1 || 'no Exit. follows the unresolved result';
      }, 'the unresolved target must exit before the next step')
      .satisfies(ordered('UPDATE_TARGET_UNRESOLVED', 'VERSION file missing'),
        'the unresolved-target gate must precede the VERSION-missing bullet, or a fully-unresolved case can fall through to "proceed to install"')
      .satisfies((text) => precedesWithin(text, 'Otherwise, if VERSION file missing', 'but the target above resolved', LINE_ENDS)
        || 'no such line', 'the VERSION-missing bullet must be explicitly scoped to exclude the unresolved-target case');
    // Every later mutation missing after the step is one cause (a truncated file), not one finding per mutation.
    update.satisfies((text) => {
      const tail = afterInstalledStep(text);
      return tail === undefined || missingAfter(tail).length < SPIES.length || 'none of the later update mutations follows the get_installed_version step';
    }, 'the later update steps must follow the get_installed_version step');
    for (const [name, needle] of SPIES) {
      installed.lacks(needle, `the unresolved path reaches ${name}`);
      update.satisfies((text) => {
        const tail = afterInstalledStep(text);
        return tail === undefined || missingAfter(tail).length === SPIES.length || tail.includes(needle) || 'not found after the step';
      }, `${name} must remain after the exit`);
    }

    const latest = update.step('check_latest_version');
    latest
      .satisfies((text) => {
        if (sectionizer.error) return true;
        const block = sectionizer.lib.extractFencedBlock(text, 'bash');
        if (!block) return 'check_latest_version must contain a bash block';
        if (hasWord(block, 'jq')) return 'latest-result parsing must not invoke jq';
        return definesUcField(block) || 'check_latest_version must define its JSON parser (uc_field) in the same shell block that invokes it';
      }, 'the latest-version step must parse its result with Node only')
      .satisfies((text) => capturesLatestStatus(text), 'latest-version failure must be captured when errexit is active')
      .has('LATEST_OK="$(uc_field ok "$LATEST_RESULT")"', 'the latest-version step must read ok through uc_field')
      .has('LATEST_OK="${LATEST_OK:-false}"', 'the latest-version step must default ok to false')
      .has('LATEST_VERSION="$(uc_field version "$LATEST_RESULT")"', 'the latest-version step must read version through uc_field')
      .has('LATEST_REASON="$(uc_field reason "$LATEST_RESULT")"', 'the latest-version step must read reason through uc_field');

    update
      .has('RUNTIME_DIR="$GSD_DIR"', 'backup_custom_files must set RUNTIME_DIR="$GSD_DIR" (the resolved config dir from update-context)')
      .lacks('="$LOCAL_DIR"', 'update.md still reads LOCAL_DIR, which get_installed_version no longer sets: the backup would be skipped')
      .lacks('="$GLOBAL_DIR"', 'update.md still reads GLOBAL_DIR, which get_installed_version no longer sets: the backup would be skipped')
      .followedBy('[ -n "$RUNTIME_DIR" ]', 'detect-custom-files --config-dir "$RUNTIME_DIR"',
        'the backup must still skip when RUNTIME_DIR is empty (UNKNOWN scope)')
      .has('--next', 'the workflow must parse --next')
      .has('--rc', 'the workflow must parse --rc')
      .has('TAG="next"', 'the workflow must set TAG="next" for the RC channel')
      .has('TAG="latest"', 'the workflow must default TAG="latest"')
      .has(/check-latest-version\.cjs"? --json --tag "\$TAG"/, 'the version check must thread the tag through check-latest-version.cjs')
      .satisfies((text) => {
        const n = countOf(text, TAGGED_INSTALL);
        return n >= 2 || `expected at least 2 tag-parameterized npx invocations, found ${n}`;
      }, 'the install must use the selected tag')
      .satisfies((text) => {
        const bare = bareClaudePaths(text);
        return bare.length === 0 || JSON.stringify(bare);
      }, 'update.md must not contain a bare ~/.claude (without trailing slash): the installer scanner flags it as an unresolved path reference')
      .satisfies((text) => {
        const stale = staleNpxForms(text);
        return stale.length === 0 || stale.join('; ');
      }, 'update.md must use the --package= form of npx, never the stale cache-prone form');
    update.step('run_update')
      .lacks(/--package=@opengsd\/gsd-core@(?:latest|next|beta|canary|rc) -- gsd-core/,
        'install lines must use the $TAG variable, never a hardcoded dist-tag literal')
      .satisfies((text) => {
        const n = robustInstalls(text);
        return n === 2 || `found ${n}`;
      }, 'run_update must hold exactly two resolved-install npx invocations');
    update.satisfies((text) => {
      const line = inferenceLineOf(text);
      if (line === undefined) return 'the PREFERRED_RUNTIME inference line must exist';
      if (updateContext.error) return true;
      return parityProblems(line, updateContext.lib.RUNTIME_DIRS);
    }, 'update.md PREFERRED_RUNTIME prose and RUNTIME_DIRS must list the same runtime -> dir pairs');

    ctx.doc(COMMAND)
      .has('--next', 'the command must document --next')
      .has('--rc', 'the command must document --rc')
      .satisfies((text) => precedesWithin(text, 'argument-hint:', '--next', LINE_ENDS) || 'no such line',
        'the command argument-hint must list --next');
  };
}

const realLoader = (file) => () => require(path.join(REAL_ROOT, file));

module.exports = {
  // The linear walkers and the loader seam, exported for the differential properties and the loader cases of
  // tests/text-contracts.batch11.test.cjs.
  walkers: {
    hasWord, definesUcField, capturesLatestStatus, bareClaudePaths, staleNpxForms, robustInstalls, countOf, slashDirs,
    tickedWord, docPairsOf, parityProblems, buildCheck,
  },
  id: 'update-workflow',
  issue: '#498',
  check: buildCheck({ loadSectionizer: realLoader(SECTIONIZER), loadUpdateContext: realLoader(UPDATE_CONTEXT) }),
};
