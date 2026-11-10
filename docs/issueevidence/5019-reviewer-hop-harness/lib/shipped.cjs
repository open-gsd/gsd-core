'use strict';
// Slices SHIPPED bash out of the workflow .md files with its own small slicer (lines / stepRegion /
// stepFence; it shares nothing with the product tests) and prints a bash script on stdout. Nothing here is hand-written workflow logic except the
// stub of `review-lane dispatch-step` (the one call that would spawn a metered CLI).
// usage: shipped.cjs dispatch|commit|prompt <worktree> <project> [head|base]
const fs = require('node:fs');
const path = require('node:path');
const [, , verb, wt, project, arm = 'head'] = process.argv;
const rd = (f) => fs.readFileSync(path.join(wt, 'gsd-core', 'workflows', f), 'utf8');
const FIX = rd('code-review-fix.md'), REVIEW = rd('code-review.md');
const GSD_TOOLS = path.join(wt, 'gsd-core', 'bin', 'gsd-tools.cjs');
const fail = (m) => { console.error(m); process.exit(2); };

const lines = (src, from, to) => {
  const l = src.replace(/\r\n/g, '\n').split('\n'), a = l.findIndex((x) => x.includes(from));
  if (a < 0) fail(`marker "${from}" not found`);
  const b = l.findIndex((x, k) => k >= a && x.trim() === to);
  if (b < 0) fail(`end "${to}" not found`);
  return l.slice(a, b + 1).join('\n');
};
const stepRegion = (src, name) => {
  const open = src.indexOf(`<step name="${name}">`), close = src.indexOf('</step>', open);
  if (open < 0 || close < 0) fail(`step "${name}" not found`);
  return src.slice(open, close + 7);
};
const stepFence = (src, name) => {
  const m = stepRegion(src, name).replace(/\r\n/g, '\n').split('\n'), a = m.findIndex((x) => /^```bash\s*$/.test(x));
  const b = m.findIndex((x, k) => k > a && /^```\s*$/.test(x));
  if (a < 0 || b < 0) fail(`step "${name}" carries no bash fence`);
  return m.slice(a + 1, b).join('\n');
};
const T = '" 2>/dev/null)';
const tmp = `${project}/tmp`, phase = `${project}/phase`;

if (verb === 'dispatch') {
  const stub = `
real_gsd_run() { node "${GSD_TOOLS}" "$@"; }
gsd_run() {
  if [ "$1" = "review-lane" ] && [ "$2" = "dispatch-step" ]; then
    cat >/dev/null
    rdir=""; prev=""; for a in "$@"; do [ "$prev" = "--run-dir" ] && rdir="$a"; prev="$a"; done
    f="$rdir/gsd-review-cursor.md"; cp "${path.join(__dirname, 'fixture', 'cursor-lane.md')}" "$f"
    printf '{"ok":true,"selection":{},"results":[{"ok":true,"slug":"cursor","reviewPath":"%s"}]}' "$f"
  else real_gsd_run "$@"; fi
}`;
  console.log([`cd "${project}"; export TMPDIR="${tmp}"; FIX_AUTO=true; PHASE_DIR="${phase}"; PADDED_PHASE=01; REPO_ROOT="${project}"; REVIEW_DEPTH=standard; DIFF_BASE=deadbeef; REVIEW_FILES=(src/messages.js src/auth.js)`,
    stub, 'set -- --cursor', stepFence(REVIEW, 'dispatch_reviewer_lanes'), 'printf "%s" "$EXTERNAL_EVIDENCE_BLOCK"'].join('\n'));
} else if (verb === 'commit') {
  console.log([`cd "${project}"; gsd_run() { node "${GSD_TOOLS}" "$@"; }`,
    `export TMPDIR="${tmp}"; REVIEW_PATH="${phase}/01-REVIEW.md"; COMMIT_DOCS=false`, stepFence(REVIEW, 'commit_review')].join('\n'));
} else if (verb === 'prompt') {
  const loop = stepRegion(FIX, 'auto_iteration_loop');
  const call = loop.indexOf('Agent(subagent_type="gsd-code-reviewer"'); if (call < 0) fail('reviewer Agent() not found');
  const from = loop.indexOf('prompt="', call) + 8, to = loop.indexOf('")', from);
  const parts = [`cd "${project}"; gsd_run() { node "${GSD_TOOLS}" "$@"; }; export TMPDIR="${tmp}"; REVIEW_PATH="${phase}/01-REVIEW.md"; PHASE_DIR="${phase}"; AUTO_MODE=true; AGENT_SKILLS_REVIEWER=""`,
  ];
  parts.push(lines(FIX, 'REVIEW_DEPTH=$(REVIEW_PATH=', T));
  parts.push(lines(FIX, 'REVIEW_FILES_ARRAY=()', T));
  parts.push(lines(loop, 'FILES_CONFIG=""', 'fi'));
  if (arm === 'head') parts.push(lines(loop, '# #5019: re-surface', `[ -n "$B" ] && EXTERNAL_EVIDENCE_BLOCK="$B"$'\\n\\n'`));
  parts.push(`PROMPT="${loop.slice(from, to)}"; printf '%s' "$PROMPT"`);
  console.log(parts.join('\n'));
} else fail('usage: shipped.cjs dispatch|commit|prompt <wt> <project> [head|base]');
