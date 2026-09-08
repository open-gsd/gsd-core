# docs-update.md — deferred elaboration

Read in full when `workflow.compact_content` is `false` (the default) — see
`gsd-core/references/compact-content-gate.md` for the check and resolution rule this
spine defers to. Each `§` below is the full text the spine condenses at the point it
names.

## § 1 — sequential_generation

**Read the work manifest first:** `Read .planning/tmp/docs-work-manifest.json` — use `canonical_queue` items for generation order. Update `status` after each doc is generated. Write the updated manifest back to disk after all docs are complete.

When the `Task` tool is unavailable, generate docs sequentially in the current context. This step replaces dispatch_wave_1, collect_wave_1, dispatch_wave_2, and collect_wave_2.

**IMPORTANT:** Do NOT use `browser_subagent`, `Explore`, or any browser-based tool. Use only file system tools (Read, Bash, Write, Grep, Glob, or equivalent tools available in your runtime).

Read `agents/gsd-doc-writer.md` instructions once before beginning. Follow the create_mode or update_mode instructions from that agent for each doc, using the same doc_assignment fields as the parallel path.

**Wave 1 (sequential — complete all three before starting Wave 2):**

For each Wave 1 doc, construct the equivalent doc_assignment block and generate the file inline:

1. **README** — mode from resolve_modes; for update/supplement mode, include existing_content
   - Construct doc_assignment: `type: readme`, `mode: {create|update|supplement}`, `preservation_mode: {value|null}`, `project_context: {INIT JSON}`, `existing_content:` (if update/supplement)
   - Explore the codebase (Read, Grep, Glob, Bash) following gsd-doc-writer create_mode / update_mode instructions
   - Write the file to the resolved path (README.md)

2. **ARCHITECTURE** — mode from resolve_modes; for update/supplement mode, include existing_content
   - Construct doc_assignment: `type: architecture`, `mode: {create|update|supplement}`, `preservation_mode: {value|null}`, `project_context: {INIT JSON}`, `existing_content:` (if update/supplement)
   - Explore the codebase following gsd-doc-writer instructions
   - Write the file to the resolved path (docs/ARCHITECTURE.md, or ARCHITECTURE.md if found at root as fallback)

3. **CONFIGURATION** — mode from resolve_modes; for update/supplement mode, include existing_content
   - Construct doc_assignment: `type: configuration`, `mode: {create|update|supplement}`, `preservation_mode: {value|null}`, `project_context: {INIT JSON}`, `existing_content:` (if update/supplement)
   - Apply VERIFY markers to any infrastructure claim not discoverable from the repository
   - Explore the codebase following gsd-doc-writer instructions
   - Write the file to the resolved path (docs/CONFIGURATION.md, or CONFIGURATION.md if found at root as fallback)

**Wave 2 (sequential — begin only after all Wave 1 docs are written):**

Wave 2 docs can reference Wave 1 outputs since they are already written. Include `wave_1_outputs` in each doc_assignment.

4. **GETTING-STARTED** — mode from resolve_modes; include wave_1_outputs: [README.md, docs/ARCHITECTURE.md, docs/CONFIGURATION.md]
5. **DEVELOPMENT** — mode from resolve_modes; include wave_1_outputs
6. **TESTING** — mode from resolve_modes; include wave_1_outputs
7. **API** (only if queued) — mode from resolve_modes; include wave_1_outputs
8. **DEPLOYMENT** (only if queued) — Apply VERIFY markers to any infrastructure claim not discoverable from the repository; include wave_1_outputs
9. **CONTRIBUTING** (only if queued) — mode from resolve_modes; include wave_1_outputs

**Monorepo per-package READMEs (only if `monorepo_workspaces` is non-empty):**

After all 9 root-level docs are written, generate per-package READMEs sequentially:

For each resolved package directory (from workspace glob expansion) that contains a `package.json`:
- Determine mode: if `{package_dir}/README.md` exists, mode = `update`; else mode = `create`
- Construct doc_assignment: `type: readme`, `mode: {create|update}`, `scope: per_package`, `package_dir: {absolute path}`, `project_context: {INIT JSON with project_root set to package directory}`, `existing_content:` (if update)
- Follow gsd-doc-writer instructions for per_package scope
- Write the file to `{package_dir}/README.md`

Continue to verify_docs.

## § 2 — fix_loop

**Read the work manifest first:** `Read .planning/tmp/docs-work-manifest.json` — identify ALL docs (canonical AND non-canonical) with `claims_failed > 0` from the verification results in `.planning/tmp/verify-*.json`. Both queues are eligible for fixes.

Correct flagged inaccuracies by re-sending failing docs to the doc-writer in fix mode. Per D-06, max 2 iterations. Per D-05, halt immediately on regression.

**Skip condition:** If all docs passed verification (no failures), skip this step.

**Iteration tracking:**
- `MAX_FIX_ITERATIONS = 2`
- `iteration = 0`
- `previous_passed_docs` = set of doc_paths where claims_failed === 0 after initial verification

**For each iteration (while iteration < MAX_FIX_ITERATIONS and there are docs with failures):**

1. For each doc with `claims_failed > 0` in the latest verification_results:
   a. Read the current file content from disk (the spine's truncation guard captures its line count from this same read).
   b. Spawn `gsd-doc-writer` agent (or invoke sequentially) with a fix assignment:
      ```xml
      <doc_assignment>
      type: {original doc type from the queue, e.g. readme}
      mode: fix
      doc_path: {relative path}
      project_context: {the same INIT JSON object every doc_assignment carries}
      existing_content: {current file content read from disk}
      failures:
        - line: {line}
          claim: "{claim}"
          expected: "{expected}"
          actual: "{actual}"
      </doc_assignment>
      ```
   c. Never batch multiple docs' failures into a single spawn — one agent call per doc.
   d. Once the agent returns, apply the spine's post-fix truncation guard (line-count comparison, restore-and-mark-corrupted on breach). A corrupted doc stays in this iteration's re-verify pass at step 2 below; it just isn't handed another fix attempt.

2. After all fix agents complete, re-verify ALL docs (not just the ones that were fixed):
   - Re-run the same verification process as verify_docs step.
   - Read updated result JSONs from `.planning/tmp/verify-{doc_filename}.json`.

3. **Regression detection (D-05):**
   For each doc in the new verification_results:
   - If this doc was in `previous_passed_docs` (passed in the prior round) AND now has `claims_failed > 0`, this is a REGRESSION.
   - If regression detected: HALT the loop immediately. Present:
     ```
     REGRESSION DETECTED -- halting fix loop.

     {doc_path} previously passed verification but now has {claims_failed} failures after fix iteration {iteration + 1}.

     This means the fix introduced new errors. Remaining failures require manual review.
     ```
     Continue to scan_for_secrets (do not attempt further fixes).

4. Update `previous_passed_docs` with docs that now pass.
5. Increment `iteration`.

**After loop exhaustion (iteration === MAX_FIX_ITERATIONS and failures remain):**

Present remaining failures:
```
Fix loop completed ({MAX_FIX_ITERATIONS} iterations). Remaining failures:

| Doc               | Failed Claims |
|-------------------|---------------|
| {doc_path}        | {count}       |

These failures require manual correction. Review the verification output in .planning/tmp/verify-*.json for details.
```

Continue to scan_for_secrets.

## § 3 — verify_only_report

**Reached when `--verify-only` is present in `$ARGUMENTS`.** This is an early-exit step — do not proceed to dispatch, generation, commit, or report steps after this step.

Invoke the gsd-doc-verifier agent in read-only mode for each file in `existing_docs` from the init JSON:

1. For each doc in `existing_docs`:
   a. Spawn `gsd-doc-verifier` (or invoke sequentially if Task tool is unavailable), passing `model="{DOC_VERIFIER_MODEL}"` as the Task/Agent call's `model` parameter — not part of the `<verify_assignment>` prompt — so `dynamic_routing`/`model_profile` tiers apply instead of the caller's session model (#3602). Omit the parameter entirely when the value is `"inherit"` or empty (#2517). Each spawn carries:
      ```xml
      <verify_assignment>
      doc_path: {doc.path}
      project_root: {the project_root field carried in the init JSON}
      </verify_assignment>
      ```
   b. Read the result JSON from `.planning/tmp/verify-{doc_filename}.json`.

2. Also count VERIFY markers in each doc: grep for `<!-- VERIFY:` in the file content.

Present a combined summary table:

```
--verify-only audit:

| File                     | Claims Checked | Passed | Failed | VERIFY Markers |
|--------------------------|----------------|--------|--------|----------------|
| README.md                | 12             | 10     | 2      | 0              |
| docs/ARCHITECTURE.md     | 8              | 8      | 0      | 0              |
| docs/CONFIGURATION.md    | 5              | 3      | 2      | 5              |
| ...                 | ...            | ...    | ...    | ...            |

Total: {total_checked} claims checked, {total_failed} failures, {total_markers} VERIFY markers requiring manual review
```

If any failures exist, show details:
```
Failed claims:
  README.md:34 - "src/cli/index.ts" (expected: file exists, actual: file not found)
  docs/CONFIGURATION.md:12 - "npm run deploy" (expected: script in package.json, actual: script not found)
```

Display note:
```
To fix failures automatically: /gsd:docs-update (runs generation + fix loop)
To regenerate all docs from scratch: /gsd:docs-update --force
```

Clean up temp files: remove `.planning/tmp/verify-*.json` files.

End workflow — do not proceed to any dispatch, commit, or report steps.
