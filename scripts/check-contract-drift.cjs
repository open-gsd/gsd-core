#!/usr/bin/env node
/**
 * check-contract-drift.cjs
 *
 * Enforces that gsd-core/references/agent-contracts.md's `## Agent Registry`
 * table stays in sync with reality:
 *
 *   1. The table itself must parse cleanly (no malformed rows).
 *   2. Every agents/*.md file must have its fenced code blocks properly
 *      closed (an unclosed fence makes in-fence marker detection unreliable).
 *   3. Every marker an agent actually emits in-fence, and every marker the
 *      registry declares for it, must agree (contractViolations' declared/
 *      emitted checks) -- unless the row opts out via `kind:
 *      artifact+query`/`structured-return`, in which case any emitted
 *      marker is itself a violation (vestigial_marker).
 *   4. Every `sentinel-match` row's declared markers must have at least one
 *      exact-case consumer somewhere under gsd-core/workflows/, commands/,
 *      or agents/ (excluding the producing agent's own file).
 *   5. Registry roster coverage: every agents/*.md file has exactly one
 *      row, every row names an agent file that exists
 *      (agent_without_contract / duplicate_registry_row / unknown_producer),
 *      and every file-shaped `Consumed by` entry resolves (unknown_consumer).
 *   6. Read-tag arm: no `<files_to_read>` survives anywhere in the consumer
 *      corpus (legacy_read_tag), and whenever a declared consumer emits
 *      `<required_reading>` the producing agent's file must reference the
 *      gate (read_tag_gate_missing).
 *   7. Reverse direction: a workflow/command matching a quoted `## TOKEN`
 *      no agent declares or emits is dispatch-on-phantom
 *      (unmatched_consumer_token) — F9's shape from the consumer side.
 *
 * Exit 0 = clean. Exit 1 = violations (with diagnostics on stderr).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
// The repo's ONE containment decision (ADR-4650, src/security.cts) — realpath-resolved, so an
// intermediate component referring outside the root is refused before this loop reads the file.
const { tryWithinRoot } = require('../gsd-core/bin/lib/security.cjs');

function resolveRoot(argv) {
  const idx = argv.indexOf('--root');
  if (idx === -1) return path.join(__dirname, '..');
  const value = argv[idx + 1];
  if (!value) {
    throw new Error('check-contract-drift: --root requires a directory argument');
  }
  return path.resolve(value);
}

const ROOT           = resolveRoot(process.argv.slice(2));
const CONTRACTS_FILE = path.join(ROOT, 'gsd-core', 'references', 'agent-contracts.md');
const AGENTS_DIR      = path.join(ROOT, 'agents');
const WORKFLOWS_DIR    = path.join(ROOT, 'gsd-core', 'workflows');
const COMMANDS_DIR     = path.join(ROOT, 'commands');

const {
  extractMarkers,
  parseAgentContracts,
  contractViolations,
  readTagViolations,
  parseConsumedByCell,
  unmatchedConsumerTokens,
  sanitizeEcho,
  REMEDIES,
} = require('./command-contract-helpers.cjs');

const { runMain } = require('./lib/cli-exit.cjs');

// ─── helpers ────────────────────────────────────────────────────────────────

function walkMarkdownFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

/**
 * referenceIncludes(content)
 *
 * Plain scan for `@~/.claude/gsd-core/references/*.md` tokens (and the bare
 * `@gsd-core/references/*.md` spelling, #4841) anywhere in an agent file's
 * content -- inside an `<execution_context>` block (already
 * covered structurally by `executionContextRefs` in command-contract-helpers,
 * but a raw regex over the whole string picks those up too) and, just as
 * importantly, OUTSIDE one: agents frequently point at a reference doc from
 * plain prose (e.g. "See @~/.claude/gsd-core/references/planner-guidance.md
 * for ...") rather than from the eager `<execution_context>` include list.
 * An agent's completion-marker contract can be authored in such a reference
 * file rather than the agent file itself -- gsd-planner declares
 * `PLANNING COMPLETE` in its registry row, but the example heading itself
 * lives in `gsd-core/references/planner-guidance.md`, which the agent only
 * `@`-includes -- so the producer scan below must follow these includes to
 * see markers an agent's contract legitimately delegates to a reference doc.
 * Returns ROOT-relative paths (`gsd-core/references/foo.md`), de-duplicated.
 */
function referenceIncludes(content) {
  const seen = new Set();
  // Both spellings the agent corpus has carried: the installed-path form the
  // installer rewrites per profile, and the bare repo-relative `@gsd-core/…`
  // form (#4841) that it does not. The bare form is now refused in agents/ by
  // tests/shipped-reference-cites.test.cjs; it is followed here so a pointer
  // that slips past that gate is still scanned rather than silently dropped.
  //
  // THE TOKEN IS CAPTURED WHOLE AND THE NAME GRAMMAR IS ANCHORED AT BOTH ENDS.
  // Nested names are allowed (`few-shot-examples/verifier.md`); every segment
  // starts with `[A-Za-z0-9_-]` — narrower than "non-dot", since `+x.md` and
  // `é.md` do not match either — so a `.` or `..` segment is never a name.
  // Anchoring is what makes that a statement about the whole pointer rather
  // than about its first few segments: an earlier form of this pattern ended
  // at `\.md` with no following boundary, so `…/references/tdd.md/xx/yy` was
  // followed as `tdd.md`, and THIS FUNCTION'S CALLER READS THE PATH IT
  // RETURNS — `fs.readFileSync` in main()'s agent loop — so a truncated prefix
  // folded the wrong file's text into the scanned corpus. Matching the whole
  // whitespace-delimited token and requiring it to satisfy the grammar end to
  // end closes that by construction, and for any separator spelling rather
  // than the ones a boundary lookahead happens to enumerate.
  //
  // ANCHORING DOES NOT ESTABLISH CONTAINMENT, and an earlier revision of this
  // comment said it did. The grammar's refusal of `.`/`..` segments covers the
  // TEXTUAL half only: an intermediate component that refers outside the tree
  // is resolved transparently on the way to the file. Containment is decided
  // separately, below, by `tryWithinRoot` — and it has to be, because this
  // loop READS what it resolves.
  //
  // A token that does not parse WHOLE is skipped rather than truncated — the
  // conservative half of the same rule. Skipping loses a scan the previous
  // behaviour did not perform correctly anyway, where following the prefix
  // reads a file the text does not name. The loud half lives in the gate:
  // tests/shipped-reference-cites.test.cjs REPORTS such a token in agents/, so
  // in a green tree this skip has nothing to skip.
  // FOUR spellings. `@$HOME/.claude/` is a second installed-path form the installer rewrites
  // explicitly (applyAgentPathRewritesInner's `/\$HOME\/\.claude\//g` replace, beside the `~/.claude/`
  // one). The fourth is a FAMILY rather than a string: `--relative-includes` (#4377) makes a local
  // install emit project-relative includes whose prefix is DERIVED from the resolved config dir, so it
  // is matched by SHAPE — one or MORE leading segments before `gsd-core` (a config dir nested under
  // the project root emits `@config/nested/gsd-core/…`), none of them `.` or `..`. The `+` keeps the
  // bare form the bare form by construction, since it needs a segment BEFORE `gsd-core`.
  //
  // THE SHAPE IS NARROWER THAN THE FAMILY, and saying otherwise would be the overstatement this
  // function has already had to retract once. `_computePathPrefix` can emit a prefix this character
  // class does not match — a config dir named `config+nested` or `ümlaut` — and widening the class to
  // arbitrary directory names is what would turn every `@scope/…` token in prose into a pointer. So a
  // prefix outside the class is not followed, which is where this follower was for ALL
  // project-relative spellings before #4841. The gate's own comment states the same bound; the two
  // must not drift apart, because between them they are the only record of it.
  const re = /@(?:(?:~|\$HOME)\/\.claude\/|(?:(?!\.\.?\/)[A-Za-z0-9._-]+\/)+)?gsd-core\/references\/(\S+)/g;
  const name = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;
  // Trailing prose punctuation is not part of a filename — a pointer may end a
  // sentence or sit inside backticks, parentheses or bold markers. The class
  // cannot eat into `.md`, which ends at `d`.
  // START-ANCHORED: this tests a CUT SUFFIX, so it must be punctuation END TO END. An unanchored
  // `/…$/` answers true for `/xx?`, which would let the loop cut a separator and call the remainder a
  // name — `tdd.md/xx?` following as `tdd.md`, the defect this whole function was rewritten to close.
  const trailingProseOnly = /^[.,;:!?)\]}>"'`*]+$/;
  let m;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1];
    // MINIMAL strip, same rule as the gate: shortest trailing run whose removal yields a valid name.
    let candidate = null;
    for (let cut = 0; cut <= raw.length; cut++) {
      const probe = raw.slice(0, raw.length - cut);
      if (cut > 0 && !trailingProseOnly.test(raw.slice(raw.length - cut))) break;
      if (name.test(probe)) { candidate = probe; break; }
    }
    if (candidate === null) continue;
    // AMBIGUITY, mirrored from the gate. If the UNSTRIPPED token also names something, the strip would
    // pick one of two readings — and this loop READS what it picks, so it declines rather than guess.
    if (candidate !== raw && fs.existsSync(path.join(ROOT, 'gsd-core', 'references', raw))) continue;
    seen.add('gsd-core/references/' + candidate);
  }
  return [...seen];
}

function remedyFor(kind) {
  return REMEDIES[kind] || 'review the registry row and agent file for drift';
}

// ─── run ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(CONTRACTS_FILE)) {
    process.stderr.write(`\nERROR check-contract-drift: contracts file not found at ${toRepoRelative(CONTRACTS_FILE)}\n\n`);
    return 1;
  }

  const contractsMd = fs.readFileSync(CONTRACTS_FILE, 'utf-8');
  const { rows: registry, errors: parseErrors } = parseAgentContracts(contractsMd);

  // knownMarkers: every marker string declared anywhere in the registry --
  // extractMarkers only ever resolves a heading against this vocabulary, it
  // never falls back to guessing a shape. Includes `(unconsumed: …)` entries
  // so their declared↔emitted agreement is checked too.
  const knownMarkers = new Set();
  for (const row of registry) {
    for (const m of row.completion_markers || []) knownMarkers.add(m);
    for (const m of row.unconsumed_markers || []) knownMarkers.add(m);
  }

  // producerMarkers: agent -> [in-fence marker strings that matched knownMarkers]
  // candidateMarkers: agent -> [in-fence marker-shaped headings NOT in knownMarkers,
  //   deduped per marker — "emitted but undeclared" is a fact about the
  //   marker, not about each line or file it appears in]
  // agentTexts: agent -> file content CONCATENATED with every
  // references/*.md file the agent @-includes, for the read-tag arm's gate
  // check. The fold is load-bearing: planner/executor/phase-researcher
  // deliver the MUST-Read gate via the shared mandatory-initial-read.md
  // include, so the agent file alone would report a gate that actually
  // arrives (the same producer-scope gap referenceIncludes() fixes for
  // markers, one layer up).
  const producerMarkers = new Map();
  const candidateMarkers = new Map();
  const agentTexts = new Map();
  const unclosedFenceViolations = [];

  // #4407: .compact.md variant siblings are an alternate rendering of their
  // canonical agent's SAME contract, not a distinct one — excluded so they
  // don't need (and can't drift from) their own registry row.
  const agentFiles = fs.existsSync(AGENTS_DIR)
    ? fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md') && !f.endsWith('.compact.md'))
    : [];

  for (const file of agentFiles) {
    const agent = file.replace(/\.md$/, '');
    const abs = path.join(AGENTS_DIR, file);
    const content = fs.readFileSync(abs, 'utf-8');
    // Single pass over the agent's @-included references: each file is read
    // once and feeds BOTH the read-tag fold (agentTexts) and marker
    // extraction (producer/candidate attribution).
    const includeTexts = [];
    for (const refRelPath of referenceIncludes(content)) {
      try {
        // CONTAIN BEFORE READ. The name grammar refuses `.`/`..` segments, which covers the TEXTUAL
        // half of containment and nothing else: an intermediate path component that refers outside
        // the tree is resolved transparently on the way to the file, so a textually-clean name can
        // still address something outside `references/`. This loop READS what it resolves and folds
        // the text into the scanned corpus, so the real path is what has to be checked.
        const refsDir = path.join(ROOT, 'gsd-core', 'references');
        const contained = tryWithinRoot(refRelPath.slice('gsd-core/references/'.length), refsDir);
        if (contained === null) continue;
        // Read the ContainedPath the predicate returned, never a re-joined path (ADR-4650).
        if (!fs.lstatSync(contained).isFile()) continue;
        includeTexts.push(fs.readFileSync(contained, 'utf-8'));
      } catch {
        // include miss — lint-command-contract rule 4 owns @-ref existence
      }
    }
    agentTexts.set(agent, [content, ...includeTexts].join('\n'));
    const { markers, candidates, unclosedFence } = extractMarkers(agentTexts.get(agent), knownMarkers);
    const inFenceMarkers = markers.filter(m => m.inFence).map(m => m.marker);
    const inFenceCandidates = candidates.filter(m => m.inFence).map(m => m.marker);

    producerMarkers.set(agent, inFenceMarkers);
    candidateMarkers.set(agent, [...new Set(inFenceCandidates)]);

    if (unclosedFence) {
      unclosedFenceViolations.push({
        kind: 'unclosed_fence',
        agent,
        marker: null,
        detail: `${toRepoRelative(abs)} has an unterminated code fence`,
      });
    }
  }

  // consumerTexts: every *.md under gsd-core/workflows/, commands/, agents/
  // — plus every file-shaped `Consumed by` entry that resolves on disk, so
  // a row citing a reference doc or an ADR (e.g. intel-updater's
  // docs/adr/22-plan-drift-guard.md) is validated against the real file and
  // its text participates in consumer matching, not just workflows.
  const consumerTexts = new Map();
  const consumerDirs = [WORKFLOWS_DIR, COMMANDS_DIR, AGENTS_DIR];
  for (const dir of consumerDirs) {
    for (const abs of walkMarkdownFiles(dir, [])) {
      consumerTexts.set(toRepoRelative(abs), fs.readFileSync(abs, 'utf-8'));
    }
  }
  for (const row of registry) {
    for (const rel of parseConsumedByCell(row.consumed_by)) {
      if (consumerTexts.has(rel)) continue;
      const abs = path.join(ROOT, rel);
      try {
        consumerTexts.set(rel, fs.readFileSync(abs, 'utf-8'));
      } catch {
        // absent — contractViolations reports it as unknown_consumer
      }
    }
  }

  const contractViolationsList = contractViolations({ registry, producerMarkers, candidateMarkers, consumerTexts });
  const readTagViolationsList = readTagViolations({ registry, agentTexts, consumerTexts });
  const reverseViolationsList = unmatchedConsumerTokens({ consumerTexts, vocabulary: knownMarkers });

  const parseViolations = parseErrors.map(e => ({
    kind: 'parse_error',
    agent: null,
    marker: null,
    detail: `agent-contracts.md:${e.line} — ${e.reason}`,
  }));

  const allViolations = [
    ...parseViolations,
    ...unclosedFenceViolations,
    ...contractViolationsList,
    ...readTagViolationsList,
    ...reverseViolationsList,
  ];

  const agentCount = registry.length;
  const markerCount = registry.reduce((n, r) => n + (r.completion_markers || []).length, 0);

  // --json: the typed surface tests consume (CONTRIBUTING "Raw Text
  // Matching" rule — the human formatter below is for operators only).
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({
        check: 'check-contract-drift',
        status: allViolations.length === 0 ? 'ok' : 'violations',
        agents: agentCount,
        markers: markerCount,
        violations: allViolations.map((v) => ({
          kind: v.kind,
          agent: v.agent ?? null,
          marker: v.marker ?? null,
          detail: sanitizeEcho(v.detail),
        })),
      }),
    );
    return allViolations.length === 0 ? 0 : 1;
  }

  if (allViolations.length === 0) {
    console.log(`ok check-contract-drift: ${agentCount} agents, ${markerCount} markers, 0 violations`);
    return 0;
  }

  // group by violation kind
  const byKind = new Map();
  for (const v of allViolations) {
    if (!byKind.has(v.kind)) byKind.set(v.kind, []);
    byKind.get(v.kind).push(v);
  }

  process.stderr.write(
    `\nERROR check-contract-drift: ${allViolations.length} violation(s) across ${byKind.size} kind(s)\n\n`,
  );

  for (const [kind, violations] of byKind) {
    process.stderr.write(`  ${kind} (${violations.length}):\n`);
    for (const v of violations) {
      const agentLabel = v.agent ? sanitizeEcho(v.agent) : '(registry)';
      const markerLabel = v.marker ? ` marker "${sanitizeEcho(v.marker)}"` : '';
      process.stderr.write(`    - ${agentLabel}${markerLabel}: ${sanitizeEcho(v.detail)}\n`);
      process.stderr.write(`      remedy: ${remedyFor(kind)}\n`);
    }
    process.stderr.write('\n');
  }

  process.stderr.write('See gsd-core/references/agent-contracts.md for the registry contract spec.\n\n');

  return 1;
}

runMain(main);
