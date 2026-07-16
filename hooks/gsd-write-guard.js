#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Write Guard — PreToolUse hook
// Blocks a whole-file Write that catastrophically shrinks a curated .planning/
// artifact (ROADMAP.md, milestone roadmaps, STATE.md).
//
// Problem (#973, fix 3 of 3): a planner read a ~16-line window of ROADMAP.md
// and Write-overwrote the whole 292-line file with it — three milestones of
// committed history destroyed. Fixes 1 and 2 (PR #989) are instructions to a
// model: they lower the probability of a clobber but cannot prevent one, and
// they protect only the agents that were audited. This hook is the defense
// that is independent of per-agent tool config: it compares the pending Write
// payload against the file on disk and hard-blocks a catastrophic shrink
// BEFORE it happens. An advisory will not do — #973 records an agent reading
// the advisory, classifying it as non-binding, and reasoning past it while
// holding a false model of what Write does.
//
// Deliberately narrow trigger:
//   - Write only (Edit/MultiEdit are scoped by construction);
//   - the target already exists on disk;
//   - the target is a curated .planning/ artifact — the project ROADMAP.md,
//     milestone roadmaps (.planning/milestones/*-ROADMAP.md), and STATE.md.
//     NOT arbitrary markdown: free-prose docs get legitimately rewritten
//     wholesale, and a guard that fires on those trains override-fatigue
//     until nobody reads it.
//
// Threshold: block when the pending payload carries fewer than SHRINK_RATIO
// (40%) of the on-disk line count. The docs-update fix-loop's 90% bar is far
// too permissive for a curated artifact — the #973 incident was a ~94.5%
// collapse and clears a 90% bar only barely. The same ~40%/floor-40 tuning
// has run clean (no false positives) as a commit-time twin downstream.
//
// Floor: files under FLOOR_LINES are exempt, so a 10 → 2 line stub never
// trips the ratio check.
//
// Escape hatch: GSD_ALLOW_PLANNING_SHRINK=1 — named in the block message —
// for legitimate milestone resets and large deletions. A guard whose bypass
// is undocumented gets bypassed with the blunt instrument instead, with
// every other guard disabled at the same time.
//
// Triggers on: Write tool calls
// Action: BLOCK (decision: 'block', exit 2) on catastrophic shrink of a curated file
// No-op: other tools, new files, non-curated paths, sub-floor files, override set,
//        hook errors (silent fail)

const fs = require('fs');
const path = require('path');

// Block when the pending payload has fewer than this fraction of the on-disk
// line count (0.4 → a Write shrinking a file below 40% of its current size).
const SHRINK_RATIO = 0.4;

// Files with fewer lines than this are exempt — small stubs get legitimately
// rewritten far below any ratio.
const FLOOR_LINES = 40;

// Curated .planning/ artifacts, matched against the resolved target path with
// separators normalised to '/'. Deliberately a closed set (see header).
// Case-insensitive: on the case-insensitive filesystems macOS and Windows
// default to, a differently-cased path is the SAME real file — a Write to
// '.planning/roadmap.md' clobbers ROADMAP.md while a case-sensitive match
// waves it through.
const CURATED_PATTERNS = [
  /(?:^|\/)\.planning\/ROADMAP\.md$/i,
  /(?:^|\/)\.planning\/STATE\.md$/i,
  /(?:^|\/)\.planning\/milestones\/[^/]+-ROADMAP\.md$/i,
];

// Count logical lines, ignoring a single trailing newline so that
// "a\nb\n" and "a\nb" both count as 2.
function countLines(text) {
  if (!text) return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function isOverrideSet() {
  const v = process.env.GSD_ALLOW_PLANNING_SHRINK;
  return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

// #2304: Kimi's native hook bus delivers Kimi's tool vocabulary in the payload
// (Write → WriteFile, Edit/MultiEdit → StrReplaceFile) while the [[hooks]]
// matcher is registered pre-translated (runtime-hooks-surface.cts
// buildKimiHooksTomlBlock) — so without normalizing the payload too, the
// matcher fires but the tool_name check below exits 0 and the guard is dormant
// on Kimi. The tool_input field names differ as well (kimi-cli
// src/kimi_cli/tools/file/{write,replace}.py): WriteFile takes `path`/`content`,
// StrReplaceFile takes `path` + `edit: Edit | list[Edit]` with `old`/`new` —
// kimi-cli's hooks/events.py forwards tool_input verbatim, so both layers need
// mapping. Accepts bare and module-qualified ('kimi_cli.tools.file:WriteFile')
// names; unknown names fall through untouched. Inlined per guard (not
// hooks/lib/): hook scripts are staged as standalone files, and a sibling
// require is a staging dependency that can fail silently.
const KIMI_TOOL_NAMES = { WriteFile: 'Write', StrReplaceFile: 'Edit' };
function normalizeKimiPayload(data) {
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES[raw.slice(raw.lastIndexOf(':') + 1)];
  if (!mapped) return data;
  data.tool_name = mapped;
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    if (input.file_path === undefined && typeof input.path === 'string') {
      input.file_path = input.path;
    }
    const edits = Array.isArray(input.edit) ? input.edit
      : (input.edit && typeof input.edit === 'object') ? [input.edit] : [];
    if (edits.length) {
      if (input.old_string === undefined && edits[0].old !== undefined) {
        input.old_string = String(edits[0].old);
      }
      if (input.new_string === undefined) {
        input.new_string = edits.map((e) => String(e.new ?? '')).join('\n');
      }
    }
  }
  return data;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(JSON.parse(input));

    // Only whole-file Write is catastrophic-by-construction; Edit/MultiEdit
    // replace bounded spans and are out of scope by design (#2255).
    if (data.tool_name !== 'Write') {
      process.exit(0);
    }

    if (isOverrideSet()) {
      process.exit(0); // documented escape hatch — legitimate reset in progress
    }

    const rawFilePath = data.tool_input?.file_path || '';
    const content = data.tool_input?.content;
    if (!rawFilePath || typeof content !== 'string') {
      process.exit(0);
    }

    // Resolve relative paths against the session cwd (the same base the
    // runtime uses), then normalise separators for the curated match.
    const cwd = data.cwd || process.cwd();
    const filePath = path.resolve(cwd, rawFilePath);
    const normalized = filePath.replace(/\\/g, '/');

    if (!CURATED_PATTERNS.some(re => re.test(normalized))) {
      process.exit(0); // not a curated planning artifact
    }

    // Only guard overwrites — creating a curated file fresh is fine.
    // ENOENT alone fails open (no baseline to protect); any OTHER read error
    // (EACCES, EISDIR, ELOOP, EMFILE, a Windows lock) fails CLOSED — a guard
    // that waves a curated Write through on a transient read error is not
    // "independent of per-agent tool config", it is a race away from #973.
    let onDisk;
    try {
      onDisk = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        process.exit(0); // does not exist — new-file Write, nothing to clobber
      }
      const output = {
        decision: 'block',
        readError: err && err.code ? String(err.code) : 'UNKNOWN',
        overrideEnvVar: 'GSD_ALLOW_PLANNING_SHRINK',
        reason:
          `Write guard: could not read '${filePath}' to compare against the pending ` +
          `Write (${err && err.code ? err.code : 'unknown read error'}). ` +
          `'${path.basename(filePath)}' is a curated planning artifact, so this guard ` +
          `fails closed rather than risk a blind overwrite. Retry once the file is ` +
          `readable, or — if this overwrite is intentional — re-run with the ` +
          `environment variable GSD_ALLOW_PLANNING_SHRINK=1 to bypass this guard once.`,
      };
      process.stdout.write(JSON.stringify(output));
      // Kimi feeds stderr (not stdout) back to the model on exit 2.
      process.stderr.write(output.reason);
      process.exit(2);
    }

    const oldLines = countLines(onDisk);
    const newLines = countLines(content);

    if (oldLines < FLOOR_LINES) {
      process.exit(0); // sub-floor stub — ratio checks are meaningless here
    }

    if (newLines >= oldLines * SHRINK_RATIO) {
      process.exit(0); // shrink (if any) is within tolerance
    }

    const pct = Math.round((newLines / oldLines) * 100);
    // Typed fields (oldLines/newLines/overrideEnvVar) ride alongside the
    // free-form reason so consumers — including this repo's tests — never
    // have to regex the prose (CONTRIBUTING.md: no raw text matching).
    const output = {
      decision: 'block',
      oldLines,
      newLines,
      overrideEnvVar: 'GSD_ALLOW_PLANNING_SHRINK',
      reason:
        `Write guard: this Write would shrink '${filePath}' from ${oldLines} lines to ` +
        `${newLines} (${pct}% of current). '${path.basename(filePath)}' is a curated planning ` +
        `artifact; a whole-file Write this much smaller usually means the payload was built ` +
        `from a partial read of the file and would destroy the sections outside that window ` +
        `(#973: a planner collapsed ROADMAP.md 292 → 16 lines this way). To fix: use Edit for ` +
        `a scoped change, or Read the full file and include every section in the Write. If ` +
        `this shrink is intentional (milestone reset, large deletion), re-run with the ` +
        `environment variable GSD_ALLOW_PLANNING_SHRINK=1 to bypass this guard once.`,
    };

    process.stdout.write(JSON.stringify(output));
    // Kimi feeds stderr (not stdout) back to the model on exit 2.
    process.stderr.write(output.reason);
    process.exit(2);
  } catch {
    // Silent fail — never block valid tool calls due to hook errors
    process.exit(0);
  }
});
