'use strict';

/**
 * #4030: every phase-scoped `loop render-hooks <point>` call site in the shipped workflow text
 * carries `--phase`. Four read-only scans (ADR-6315 item 19: a check that only reads repo
 * content is a static check run by scripts/run-static-checks.cjs, never a test):
 *   1. counts     — each SITES row has exactly `count` call sites.
 *   2. unlisted   — every call site under gsd-core/ is a SITES row or a named PHASE_LESS_SITES
 *                   exemption; a named row that no longer exists is a violation too.
 *   3. dead-store — a PHASE_NUMBER binding that a later one in the same file overwrites before
 *                   anything reads it. The last binding is exempt: a Read-loaded step may use it.
 *   4. fences     — each SITES call passes a quoted phase variable and the --ws forward, and its
 *                   own bash fence (each fence is its own shell) carries the pinned lines that
 *                   capture GSD_ARGS, derive GSD_WS and bind the phase variable; a variable the
 *                   bind reads from another fence is pinned in SRC_CROSS_FENCE.
 * The call grammar is `renderHooksCallRe` of lint-verify-lifecycle-writes.cjs: one owner.
 */

const fs = require('node:fs');
const path = require('node:path');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');
const { escapeRegex } = require('../../gsd-core/bin/lib/pattern.cjs');
const { scanFencedBlocks } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { formatDiagnosticToken } = require('../../gsd-core/bin/lib/io.cjs');
const { joinContinuations, renderHooksCallRe } = require('../lint-verify-lifecycle-writes.cjs');

// [file, point, count] tuples: how many render-hooks <point> call sites that file has. Scan 4
// checks that each of them carries --phase, so a --phase-less duplicate is caught, not just a removal.
const SITES = [
  ['gsd-core/workflows/discuss-phase.md', 'discuss:pre', 1],
  ['gsd-core/workflows/discuss-phase.md', 'discuss:post', 1],
  ['gsd-core/workflows/plan-phase.md', 'plan:pre', 4],
  ['gsd-core/workflows/plan-phase.md', 'plan:post', 1],
  ['gsd-core/workflows/execute-phase/steps/pre-execute-gate-hooks.md', 'execute:pre', 1],
  ['gsd-core/workflows/execute-phase.md', 'execute:post', 1],
  ['gsd-core/workflows/execute-phase.md', 'execute:wave:pre', 1],
  ['gsd-core/workflows/execute-phase.md', 'execute:wave:post', 1],
  ['gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', 'execute:post', 2],
  ['gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', 'verify:post', 1],
  ['gsd-core/workflows/verify-work.md', 'verify:pre', 1],
  ['gsd-core/workflows/verify-work.md', 'verify:post', 1],
  ['gsd-core/workflows/secure-phase.md', 'verify:post', 1],
  ['gsd-core/workflows/validate-phase.md', 'verify:post', 1],
  ['gsd-core/workflows/autonomous.md', 'execute:post', 1],
  ['gsd-core/workflows/autonomous.md', 'verify:post', 1],
  ['gsd-core/references/autonomous-ui-design-contract.md', 'plan:pre', 1],
];

// Call sites that pass no --phase by design (ADR-4030 Scope notes): task- or
// milestone-scoped, or the workflow takes its own phase argument.
const PHASE_LESS_SITES = [
  ['gsd-core/workflows/ship.md', 'ship:pre'],
  ['gsd-core/workflows/ship.md', 'ship:post'],
  ['gsd-core/workflows/quick.md', 'plan:pre'],
  ['gsd-core/workflows/quick.md', 'execute:post'],
  ['gsd-core/workflows/quick-batch/steps/planner-wave.md', 'plan:pre'],
  ['gsd-core/workflows/audit-milestone.md', 'verify:post'],
  // advisory reviewer rules, read at execute:post or execute:wave:post; takes no phase context (ADR-4030 Scope notes)
  ['gsd-core/workflows/code-review.md', '${REVIEWER_POINT}'],
];

// Matches one `render-hooks <point>` call site and captures its argument tail. The call grammar
// (any whitespace, an optionally quoted point) is the lifecycle lint's: one owner, built there.
function callRe(point) {
  return new RegExp(`${renderHooksCallRe(point).source}([^)\\n]*)`);
}

// The discovery form of the same grammar: it captures the point instead of taking it.
// A point read from a shell variable (`"${REVIEWER_POINT}"`) is a call site too: it is captured as written.
const CALL_POINT_RE = /render-hooks\s+"?([a-z]+(?::[a-z]+)+|\$\{\w+\}|\$\w+)(?:"|\b|(?<=\}))/;

// The logical lines of `lines` that can hold a call site. --active-cap lines are excluded: that mode
// returns only 'true'/'false' for one capability's activation (unaffected by phase) and never reads
// `context` (#4030). The one owner of that exclusion, for the counts and the unlisted scan alike.
const callLines = (lines) => joinContinuations(lines).filter(({ text }) => !text.includes('--active-cap'));

// Every `render-hooks <point>` call of `lines` (two calls on one logical line are two sites): the match
// and `idx`, the first physical line of its backslash-continued logical line.
const callSites = (lines, point) => callLines(lines).flatMap(({ text, line }) =>
  [...text.matchAll(new RegExp(callRe(point).source, 'g'))].map((m) => ({ m, idx: line - 1 })));

// The variable a call's argument tail passes to --phase as `"$NAME"` or `"${NAME}"` (balanced braces), or
// null: the one owner of "this call carries a quoted phase variable".
const phaseVarOf = (tail) => {
  const v = tail.match(/--phase\s+(?:"\$(\w+)"|"\$\{(\w+)\}")/);
  return v && (v[1] || v[2]);
};

// The call sites of a file and how many carry a quoted phase variable.
function phaseSiteCounts(content, point) {
  const bare = callSites(splitLines(content), point).map((s) => s.m);
  return { bare, withPhase: bare.filter((m) => phaseVarOf(m[1]) !== null) };
}

// A shell assignment of `name` at the start of a line. `name="{placeholder}"` is text the agent fills
// in, not a shell binding, so it never matches. One owner: scans 3 and 4 share it.
const assignRe = (name) => new RegExp(`^\\s*(?:export\\s+|local\\s+)?${escapeRegex(name)}=(?!"?\\{)`);

// One violation: the runner reports `{file, line, message}`; `code` is the stable key the tests assert on.
// `typed` holds the fields a message names, so tests assert them, not the prose: `echoed`, the escaped
// workflow line it quotes (formatDiagnosticToken), and `site`, the `file :: point` key it is about.
const row = (file, line, code, message, typed) => ({ file, line, code, message, ...typed });

// null for a file that is gone: a renamed or deleted SITES file is a violation row, never an ENOENT crash.
const readRel = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

// Scan 1: the per-row counts.
function scanSiteCounts(root, sites = SITES) {
  const violations = [];
  for (const [file, point, count] of sites) {
    const content = readRel(root, file);
    if (content === null) {
      violations.push(row(file, 0, 'SITES_FILE_MISSING', `${file} :: ${point}: the SITES file does not exist — update the SITES row if the file was renamed or deleted`));
      continue;
    }
    const found = phaseSiteCounts(content, point).bare.length;
    if (found !== count) {
      violations.push(row(file, 0, 'SITE_COUNT', `${file} :: ${point}: expected ${count} render-hooks call site(s), found ${found} — update the SITES count if the site count genuinely changed`));
    }
  }
  return violations;
}

// Scan 2: a call site must be a SITES row or a named phase-less site, and each named row must exist.
function scanUnlistedSites(root, sites = SITES, phaseLess = PHASE_LESS_SITES) {
  const found = new Map();
  for (const rel of fs.readdirSync(path.join(root, 'gsd-core'), { recursive: true })) {
    if (!rel.endsWith('.md')) continue;
    const file = `gsd-core/${rel.split(path.sep).join('/')}`;
    for (const { text } of callLines(splitLines(readRel(root, file)))) {
      for (const m of text.matchAll(new RegExp(CALL_POINT_RE.source, 'g'))) found.set(`${file} :: ${m[1]}`, file);
    }
  }
  const named = new Map([...sites, ...phaseLess].map(([f, p]) => [`${f} :: ${p}`, f]));
  return [
    ...[...found].filter(([k]) => !named.has(k)).sort().map(([k, f]) => row(f, 0, 'UNLISTED_SITE', `${k}: a call site in neither SITES nor PHASE_LESS_SITES`)),
    ...[...named].filter(([k]) => !found.has(k)).sort().map(([k, f]) => row(f, 0, 'STALE_SITE', `${k}: a named site that no longer exists`)),
  ];
}

// Scan 3: a PHASE_NUMBER binding overwritten before it is read.
function scanDeadPhaseStores(root, sites = SITES) {
  const assign = assignRe('PHASE_NUMBER');
  const read = /\$\{?PHASE_NUMBER\b/;
  const violations = [];
  for (const file of new Set(sites.map(([f]) => f))) {
    const content = readRel(root, file);
    if (content === null) continue; // scanSiteCounts reports the missing file
    const lines = splitLines(content);
    const binds = lines.flatMap((l, i) => (assign.test(l) ? [i] : []));
    binds.slice(0, -1).forEach((i, k) => {
      const next = binds[k + 1];
      const between = lines.slice(i + 1, next).concat(lines[next].replace(assign, ''));
      if (!between.some((l) => read.test(l))) violations.push(row(file, i + 1, 'DEAD_PHASE_STORE', `${file}:${i + 1}: PHASE_NUMBER is overwritten before it is read`));
    });
  }
  return violations;
}

// The fenced blocks of `lines` as `{from, to, bash}`, `from` the first body line and `to` the closer line
// (end of file when it never closes). The fence grammar is the markdown seam's `scanFencedBlocks`, the one
// owner; this projection only names the bash blocks. Only the canonical three-backtick `bash`/`sh` fence is
// bash: every other spelling (~~~, four backticks, another info word) binds nothing and its site reports
// a row, which fails closed.
const fences = (lines) => scanFencedBlocks(lines).map((b) => ({
  from: b.openLineIdx + 1,
  to: b.closeLineIdx === -1 ? lines.length : b.closeLineIdx,
  bash: b.char === '`' && b.len === 3 && /^(bash|sh)$/.test(b.infoString.split(/\s+/)[0]),
}));

// The last assignment of `name` before lines[idx] in any bash fence. `line` is its index (-1: none, so
// the variable would expand empty and degrade to `--phase ""`); `sameFence` says whether it sits in
// the call's own fence. A `name="{placeholder}"` line is text the agent fills in, so it never counts.
function phaseVarBinding(lines, idx, name) {
  const assign = assignRe(name);
  const bash = fences(lines).filter((f) => f.bash);
  let line = -1;
  for (const f of bash) for (let i = f.from; i < Math.min(f.to, idx); i++) if (assign.test(lines[i])) line = i;
  return { line, sameFence: line !== -1 && bash.some((f) => f.from <= line && idx < f.to && line < idx) };
}

// The first of `need` that `own` does not carry in order, or null. A need may span lines: it matches
// only as that exact run of lines.
function firstMissing(own, need) {
  const text = `\n${own.join('\n')}\n`;
  let at = 0;
  for (const n of need) {
    const hit = text.indexOf(`\n${n}\n`, at);
    if (hit === -1) return n;
    at = hit + n.length + 1;
  }
  return null;
}

// Each fence runs as its own shell, so every site binds its phase variable in the call's own fence
// (a missed bind degrades to `--phase ""`, which warns and omits context, ADR-4030). A fence with no
// INIT takes the first positional token of $GSD_ARGS: it skips every flag and the value of --ws and
// --wave. The variables a binding reads from an earlier fence are pinned in SRC_CROSS_FENCE.
const ARGS_BIND = [
  'read -ra _gsd_argv <<<"$GSD_ARGS"; set -- "${_gsd_argv[@]}"',
  'while [ "$#" -gt 0 ]; do case "$1" in --ws|--wave) shift; [ "$#" -gt 0 ] && shift;; -*) shift;; *) break;; esac; done',
];

// Sites that pass the autonomous driver's own loop variable. It is never
// shell-assigned (the host substitutes it, as in every other command of those
// files), and it always names the phase being driven: deriving the token from
// $PHASE_STATE instead named the NEXT phase once step 3a rebound it while the
// background execute of this one was still running.
const HOST_PHASE_VAR = 'PHASE_NUM';
const HOST_BOUND = new Set([
  'gsd-core/workflows/autonomous.md :: execute:post',
  'gsd-core/workflows/autonomous.md :: verify:post',
  'gsd-core/references/autonomous-ui-design-contract.md :: plan:pre',
]);

// A Read-loaded file (a steps/ file or a reference) is not textually substituted, so each of its
// fences that captures $ARGUMENTS tells the agent to write the parent's argument string there.
const READ_LOADED_NOTE = "# #4772: this file is Read, not textually substituted - write the parent command's original argument string in place of $ARGUMENTS so --ws reaches the query.";

// The PHASE_NUMBER binds a site may use in its own fence: the positional token of
// $GSD_ARGS (after ARGS_BIND) through gsd-tools' own `--pick` field extractor, kept
// if already set or not, or verify-work's `jq` read of its own $INIT (#5289).
const PHASE_QUERY = 'gsd_run query init.phase-op ${GSD_WS:+--ws=${GSD_WS##* }} "${1}" --pick phase_number';
const INIT_JQ_BIND = `PHASE_NUMBER=$(printf '%s' "$INIT" | jq -r '.phase_number // empty')`;
const PHASE_VAR_QUERY = PHASE_QUERY.replace('"${1}"', '"${PHASE}"');
// The three lines every site's fence carries, in this order, before the call: the heredoc capture of the
// argument string, the trim of its newline and the derive of GSD_WS (its `["']?` keeps a quoted --ws
// value whole). Each is exact: a suffix on the derive line could rebind GSD_WS.
const GSD_ARGS_CAPTURE = "IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true";
const GSD_ARGS_TRIM = "GSD_ARGS=${GSD_ARGS%$'\\n'}";
const GSD_WS_LINE = String.raw`GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +["'\'']?([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -1)`;
const OWN_BINDS = [`PHASE_NUMBER=$(${PHASE_QUERY})`, `PHASE_NUMBER=\${PHASE_NUMBER:-$(${PHASE_QUERY})}`, INIT_JQ_BIND, `PHASE_NUMBER=\${PHASE_NUMBER:-$(${PHASE_VAR_QUERY})}`];
// For the variable the phase binding READS: a binding that reads $INIT still
// relies on the host carrying it from an earlier fence. Keyed `file :: point` -> exact line.
// verify-work binds PHASE_NUMBER from $INIT (#5289), which its first fence assigns.
const VERIFY_WORK_INIT = 'INIT=$(gsd_run query init.verify-work "${PHASE_ARG}" ${GSD_WS:+--ws=${GSD_WS##* }})';
const SRC_CROSS_FENCE = {
  'gsd-core/workflows/verify-work.md :: verify:pre': VERIFY_WORK_INIT,
  'gsd-core/workflows/verify-work.md :: verify:post': VERIFY_WORK_INIT,
  // plan-phase resolves its phase once (arguments, --research-phase, auto-detect), so its binds read $PHASE, not the first token of GSD_ARGS.
  'gsd-core/workflows/plan-phase.md :: plan:pre': 'PHASE="${BASH_REMATCH[1]}"',
  'gsd-core/workflows/plan-phase.md :: plan:post': 'PHASE="${BASH_REMATCH[1]}"',
};

const WS_EXPANSION = '${GSD_WS:+--ws=${GSD_WS##* }}';

// What is wrong with the lines of `own` (the call's bash fence, trimmed; null when the call sits in none)
// for a call at `before` lines in: the first problem as a message, or null. The pinned lines come once and
// in order before the call; the fence's only GSD_WS and GSD_ARGS assignments are the derive and the trim,
// so no rebind sits before or after the call; a positional bind follows ARGS_BIND as one run of lines.
function fenceProblem(own, before, { file, positionalBind }) {
  if (own === null) return 'the call sits in no bash fence';
  const readLoaded = path.posix.dirname(file) !== 'gsd-core/workflows';
  const need = [[GSD_ARGS_CAPTURE, '$ARGUMENTS', 'GSD_ARGS_END'].join('\n'), GSD_ARGS_TRIM, GSD_WS_LINE, ...(positionalBind ? [[...ARGS_BIND, positionalBind].join('\n')] : [])];
  const gap = firstMissing(own.slice(0, before), need);
  if (gap !== null) return `the fence must carry, in order before the call: ${formatDiagnosticToken(gap)}`;
  if (readLoaded && !own.includes(READ_LOADED_NOTE)) return "a Read-loaded file's fence must carry the #4772 note for its $ARGUMENTS capture";
  const only = (name, line) => own.filter((l) => assignRe(name).test(l)).join('\n') === line;
  if (!only('GSD_WS', GSD_WS_LINE) || !only('GSD_ARGS', GSD_ARGS_TRIM)) return 'the fence assigns GSD_WS or GSD_ARGS by a line other than the shared derive and trim';
  if (own.filter((l) => l === GSD_ARGS_CAPTURE).length !== 1) return 'the fence captures GSD_ARGS more than once';
  return null;
}

// Scan 4: the fence structure of each call site. `pins` is SRC_CROSS_FENCE: `file :: point` -> the exact line
// of each variable the phase bind reads from another fence. The e2e tests in tests/loop-render-hooks.test.cjs
// run the bind lines this scan accepts.
function scanSiteFences(root, sites = SITES, pins = SRC_CROSS_FENCE) {
  const violations = [];
  const pinUsed = new Set();
  for (const [file, point] of sites) {
    const content = readRel(root, file);
    if (content === null) continue; // scanSiteCounts reports the missing file
    const lines = splitLines(content);
    const bash = fences(lines).filter((f) => f.bash);
    const key = `${file} :: ${point}`;
    const bad = (i, code, message, typed) => violations.push(row(file, i + 1, code, `${file}:${i + 1} ${point}: ${message}`, typed));
    for (const { m, idx } of callSites(lines, point)) { // a wrapped call is judged at its first physical line
      const phaseVar = phaseVarOf(m[1]);
      if (phaseVar === null) {
        bad(idx, 'PHASE_ARG', '--phase must take a quoted variable');
        continue;
      }
      if (!m[1].includes(WS_EXPANSION)) bad(idx, 'WS_EXPANSION', `--phase call lost the ${WS_EXPANSION} expansion (wrong-workstream phase)`);
      const b = phaseVarBinding(lines, idx, phaseVar);
      let bindLine = null;
      if (HOST_BOUND.has(key)) {
        if (phaseVar !== HOST_PHASE_VAR) bad(idx, 'HOST_BOUND', `a host-bound site must pass ${HOST_PHASE_VAR}`);
        if (b.line !== -1) bad(idx, 'HOST_BOUND', `${phaseVar} is shell-assigned now; drop the site from HOST_BOUND`);
      } else if (b.line === -1) {
        bad(idx, 'PHASE_BIND', `${phaseVar} is never assigned in a bash block before this call`);
      } else if (!b.sameFence) {
        bad(idx, 'PHASE_BIND', `${phaseVar} is bound in another fence (line ${b.line + 1}); each fence is its own shell, so bind it in this fence`);
      } else if (!OWN_BINDS.includes(lines[b.line].trim())) {
        const echoed = formatDiagnosticToken(lines[b.line].trim());
        bad(b.line, 'PHASE_BIND', `unexpected ${phaseVar} bind: ${echoed}`, { echoed });
      } else {
        bindLine = lines[b.line].trim();
      }
      const fence = bash.find((f) => f.from <= idx && idx < f.to);
      const problem = fenceProblem(fence ? lines.slice(fence.from, fence.to).map((l) => l.trim()) : null, fence ? idx - fence.from : 0, { file, positionalBind: bindLine?.includes('${1}') ? bindLine : null });
      if (problem !== null) bad(idx, 'FENCE_LINE', problem);
      if (bindLine === null) continue;
      // The phase binding also reads source variables ($INIT, $PHASE, ...): each one assigned in another fence is pinned.
      for (const name of new Set([...bindLine.matchAll(/\$\{?(\w+)/g)].map((r) => r[1]))) {
        const src = phaseVarBinding(lines, b.line, name);
        if (name === phaseVar || src.line === -1 || src.sameFence) continue;
        pinUsed.add(key);
        if (pins[key] === undefined) bad(idx, 'CARRY', `${name} is bound in another fence (line ${src.line + 1}); list the site in SRC_CROSS_FENCE`);
        else if (pins[key] !== lines[src.line].trim()) {
          const echoed = formatDiagnosticToken(lines[src.line].trim());
          bad(idx, 'CARRY', `the ${name} binding this site relies on changed (now: ${echoed})`, { echoed });
        }
      }
    }
  }
  for (const key of Object.keys(pins).filter((k) => !pinUsed.has(k))) {
    violations.push(row(key.split(' :: ')[0], 0, 'PIN_STALE', `${key}: a SRC_CROSS_FENCE pin that no SITES row uses, or whose bind reads nothing from another fence now; drop it`, { site: key }));
  }
  return violations;
}

function run({ root }) {
  return [...scanSiteCounts(root), ...scanUnlistedSites(root), ...scanDeadPhaseStores(root), ...scanSiteFences(root)];
}

module.exports = {
  name: 'render-hooks-phase-sites',
  run,
  SITES, PHASE_LESS_SITES,
  callRe, callSites, phaseVarOf, phaseSiteCounts, assignRe, CALL_POINT_RE, fences, phaseVarBinding,
  scanSiteCounts, scanUnlistedSites, scanDeadPhaseStores, scanSiteFences,
  ARGS_BIND, HOST_BOUND, VERIFY_WORK_INIT, WS_EXPANSION,
  GSD_ARGS_CAPTURE, GSD_ARGS_TRIM, GSD_WS_LINE, READ_LOADED_NOTE,
};
