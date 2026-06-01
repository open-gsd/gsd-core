<purpose>
Create a pull request from completed phase/milestone work, generate a rich PR body from planning artifacts, optionally run code review, and prepare for merge. Closes the plan → execute → verify → ship loop.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="initialize">
Parse arguments and load project state:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/get-shit-done/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi
INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse from init JSON: `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `padded_phase`, `commit_docs`.

Also load config for branching strategy:
```bash
CONFIG=$(gsd_run query state.load)
```

Extract: `branching_strategy`, `branch_name`.

Detect base branch for PRs and merges:
```bash
BASE_BRANCH=$(gsd_run query config-get git.base_branch 2>/dev/null || echo "")
if [ -z "$BASE_BRANCH" ] || [ "$BASE_BRANCH" = "null" ]; then
  BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||')
  BASE_BRANCH="${BASE_BRANCH:-main}"
fi
```
</step>

<step name="preflight_checks">
Verify the work is ready to ship:

1. **Verification passed?**
   ```bash
   VERIFICATION=$(cat ${PHASE_DIR}/*-VERIFICATION.md 2>/dev/null)
   ```
   Check for `status: pass` or `status: passed`.
   If no VERIFICATION.md or status is anything other than `pass` / `passed` (including `human_needed` / `gaps_found`): block with `PHASE_VERIFICATION_INCOMPLETE`; complete or formally re-run verification before shipping.

2. **Clean working tree?**
   ```bash
   git status --short
   ```
   If uncommitted changes exist: ask user to commit or stash first.

3. **On correct branch?**
   ```bash
   CURRENT_BRANCH=$(git branch --show-current)
   ```
   If on `${BASE_BRANCH}`: warn — should be on a feature branch.
   If branching_strategy is `none`: offer to create a branch now.

4. **Remote configured?**
   ```bash
   git remote -v | head -2
   ```
   Detect `origin` remote. If no remote: error — can't create PR.

5. **`gh` CLI available?**
   ```bash
   which gh && gh auth status 2>&1
   ```
   If `gh` not found or not authenticated: provide setup instructions and exit.
</step>

<step name="push_branch">
Push the current branch to remote:

```bash
git push origin ${CURRENT_BRANCH} 2>&1
```

If push fails (e.g., no upstream): set upstream:
```bash
git push --set-upstream origin ${CURRENT_BRANCH} 2>&1
```

Report: "Pushed `{branch}` to origin ({commit_count} commits ahead of ${BASE_BRANCH})"
</step>

<step name="generate_pr_body">
Auto-generate a rich PR body from planning artifacts:

**1. Title:**
```
Phase {phase_number}: {phase_name}
```
Or for milestone: `Milestone {version}: {name}`

**2. Summary section:**
Read ROADMAP.md for phase goal. Read VERIFICATION.md for verification status.

```markdown
## Summary

**Phase {N}: {Name}**
**Goal:** {goal from ROADMAP.md}
**Status:** Verified ✓

{One paragraph synthesized from SUMMARY.md files — what was built}
```

**3. Changes section:**
For each SUMMARY.md in the phase directory:
```markdown
## Changes

### Plan {plan_id}: {plan_name}
{one_liner from SUMMARY.md frontmatter}

**Key files:**
{key-files.created and key-files.modified from SUMMARY.md frontmatter}
```

**4. Requirements section:**
```markdown
## Requirements Addressed

{REQ-IDs from plan frontmatter, linked to REQUIREMENTS.md descriptions}
```

**5. Testing section:**
```markdown
## Verification

- [x] Automated verification: {pass/fail from VERIFICATION.md}
- {human verification items from VERIFICATION.md, if any}
```

**6. Decisions section:**
```markdown
## Key Decisions

{Decisions from STATE.md accumulated context relevant to this phase}
```

**7. Configured project sections:**
Read append-only project-specific PRD/PR body sections from config:

```bash
CUSTOM_PR_SECTIONS=$(gsd_run query config-get ship.pr_body_sections --default '[]' 2>/dev/null || echo '[]')
```

`ship.pr_body_sections` is an onboarding-time extension point for teams that need extra PRD-style sections such as `User Stories & Acceptance Criteria`, `Risks & Dependencies`, `Success Metrics`, `Release Criteria`, or `Stakeholder Review & Approval`.

Use these sections for lean/agile PRD material that should travel with the PR without making the core `/gsd:ship` body configurable:

- User stories and acceptance criteria that explain the functional increment from the user's point of view.
- Definition of Done or release criteria that make the completion standard explicit.
- Risks, dependencies, stakeholder review, and traceability notes needed by regulated or approval-heavy projects.

Rules:

- Treat configured sections as append-only. They are rendered after `Key Decisions` and cannot replace, remove, or reorder the required core sections: `Summary`, `Changes`, `Requirements Addressed`, `Verification`, and `Key Decisions`.
- Each entry must have `heading` plus at least one of `source`, `template`, or `fallback`.
- `enabled` defaults to `true`; when `enabled` is `false`, skip the section without warning. This lets onboarding seed optional sections that a project can enable later.
- `source` is a fallback chain of planning artifact headings: `PLAN.md ## Risks || VERIFICATION.md ## Manual Checks`. Allowed artifacts are `ROADMAP.md`, `PLAN.md`, `SUMMARY.md`, `VERIFICATION.md`, `STATE.md`, `REQUIREMENTS.md`, and `CONTEXT.md`.
- `template` is literal Markdown with a closed token namespace only: `{phase_number}`, `{phase_name}`, `{phase_dir}`, `{base_branch}`, `{padded_phase}`.
- `fallback` is literal Markdown used when `source` finds no content and no `template` is present.
- Omit sections whose final rendered body is empty after trimming.

Example configured sections:

```json
[
  {
    "heading": "User Stories & Acceptance Criteria",
    "enabled": true,
    "source": "REQUIREMENTS.md ## User Stories || REQUIREMENTS.md ## Acceptance Criteria",
    "fallback": "- Acceptance criteria are covered by the linked requirements and verification evidence."
  },
  {
    "heading": "Risks & Dependencies",
    "enabled": true,
    "source": "PLAN.md ## Risks || PLAN.md ## Dependencies",
    "fallback": "- No known high-risk rollout dependencies."
  },
  {
    "heading": "Stakeholder Review & Approval",
    "enabled": false,
    "template": "- Product owner approval pending for {phase_name}."
  }
]
```

**8. TDD Audit section:**

Reconstruct the per-commit TDD gate trail before squash-merge discards it. Walk the PR branch's own commits (merges excluded) and read each commit's `gate_status:` trailer with Git's native trailer machinery — never a raw `%B` grep, which would also match the string written in prose:

```bash
# Anchor on the merge-base so a stale local ${BASE_BRANCH} ref cannot over-count.
RANGE_BASE=$(git merge-base "${BASE_BRANCH}" HEAD)
git log "${RANGE_BASE}..HEAD" --no-merges --reverse \
  --format='%H%x1f%s%x1f%(trailers:key=gate_status,valueonly,separator=%x2c)%x1e'
```

Records are separated by `\x1e`; the fields inside each are `\x1f`-separated — `<sha>`, `<subject>`, `<gate_status value>`.

Pair commits by their conventional-commit type (the `type:` prefix of the subject):

- A `test:` commit is the RED row. Pair it with the next following **implementation** commit — a `feat:` or `fix:` — as its **Impl commit** (the GREEN step), skipping over any intervening `refactor:`, `docs:`, or `chore:` commits so they are never mistaken for the GREEN step.
- A `refactor:`, `docs:`, or `chore:` commit that is not consumed as an Impl pairing is a standalone row with Impl commit `—`.
- A `feat:`/`fix:` commit with no preceding unpaired `test:` is a standalone row.

Surface each commit's `gate_status:` value, normalized to exactly one of `skill`, `fallback`, `exempt`, or `missing` — never the raw trailer text. A commit whose trailer is absent, whose value is none of the first three, or which carries more than one `gate_status:` trailer (ambiguous) is counted as **missing** and still listed. This section is informational; it never blocks the ship.

Harden every table cell against injection, not just subjects: escape `|` as `\|` and strip `\r`/`\n` from both commit subjects and the rendered `gate_status` value. Prefer NUL (`-z` / `%x00`) record separation, and reject any record whose fields contain the `\x1f`/`\x1e` delimiters, so an adversarial commit message cannot corrupt record or field boundaries.

```markdown
## TDD Audit

| Test commit | Impl commit | gate_status |
|---|---|---|
| `a1b2c3d` test: failing parser test | `e4f5g6h` feat: implement parser | skill |
| `i7j8k9l` test: failing export test | `m0n1o2p` feat: implement export | fallback |
| `q3r4s5t` refactor: extract helper | — | exempt |

Aggregate: 2 skill, 1 fallback, 1 exempt — 0 missing.
```

This `## TDD Audit` section is the final body section — it renders after the configured `pr_body_sections`, immediately before the aggregate trailer — so the frozen core sections and the append-only configured sections both keep their existing order.

**9. Aggregate gate_status trailer (final line):**

After every other section — including any configured `pr_body_sections` — emit the audit aggregate as a single Git trailer on the **final line** of the PR body, preceded by a blank line so it parses as a valid trailer:

```
gate_status: skill=2, fallback=1, exempt=1, missing=0
```

Use the exact key order `skill=`, `fallback=`, `exempt=`, `missing=` so downstream tooling parses it stably. Keeping it last means a GitHub squash-merge that defaults its commit message to the PR description carries the aggregate into `${BASE_BRANCH}`, preserving the audit footprint in `git log` after the PR branch is deleted. (Best-effort: it depends on the repo's squash-message default; the in-body `## TDD Audit` section is the source of truth regardless.)
</step>

<step name="create_pr">
Create the PR using the generated body. Write the body to a temp file first so large generated PRD sections do not hit shell argument limits:

```bash
PR_BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/gsd-pr-body.XXXXXX.md")
trap 'rm -f "${PR_BODY_FILE:-}"' EXIT
printf '%s\n' "${PR_BODY}" > "${PR_BODY_FILE}"

gh pr create \
  --title "Phase ${PHASE_NUMBER}: ${PHASE_NAME}" \
  --body-file "${PR_BODY_FILE}" \
  --base "${BASE_BRANCH}"
```

If `--draft` flag was passed: add `--draft`.

Report: "PR #{number} created: {url}"
</step>

<step name="optional_review">

**External code review command (automated sub-step):**

Before prompting the user, check if an external review command is configured:

```bash
REVIEW_CMD=$(gsd_run query config-get workflow.code_review_command 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
```

If `REVIEW_CMD` is non-empty and not `"null"`, run the external review:

1. **Generate diff and stats:**
   ```bash
   DIFF=$(git diff ${BASE_BRANCH}...HEAD)
   DIFF_STATS=$(git diff --stat ${BASE_BRANCH}...HEAD)
   ```

2. **Load phase context from STATE.md:**
   ```bash
   STATE_STATUS=$(gsd_run query state.load 2>/dev/null | head -20)
   ```

3. **Build review prompt and pipe to command via stdin:**
   Construct a review prompt containing the diff, diff stats, and phase context, then pipe it to the configured command:
   ```bash
   REVIEW_PROMPT="You are reviewing a pull request.\n\nDiff stats:\n${DIFF_STATS}\n\nPhase context:\n${STATE_STATUS}\n\nFull diff:\n${DIFF}\n\nRespond with JSON: { \"verdict\": \"APPROVED\" or \"REVISE\", \"confidence\": 0-100, \"summary\": \"...\", \"issues\": [{\"severity\": \"...\", \"file\": \"...\", \"line_range\": \"...\", \"description\": \"...\", \"suggestion\": \"...\"}] }"
   REVIEW_OUTPUT=$(echo "${REVIEW_PROMPT}" | timeout 120 ${REVIEW_CMD} 2>/tmp/gsd-review-stderr.log)
   REVIEW_EXIT=$?
   ```

4. **Handle timeout (120s) and failure:**
   If `REVIEW_EXIT` is non-zero or the command times out:
   ```bash
   if [ $REVIEW_EXIT -ne 0 ]; then
     REVIEW_STDERR=$(cat /tmp/gsd-review-stderr.log 2>/dev/null)
     echo "WARNING: External review command failed (exit ${REVIEW_EXIT}). stderr: ${REVIEW_STDERR}"
     echo "Continuing with manual review flow..."
   fi
   ```
   On failure, warn with stderr output and fall through to the manual review flow below.

5. **Parse JSON result:**
   If the command succeeded, parse the JSON output and report the verdict:
   ```bash
   # Parse verdict and summary from REVIEW_OUTPUT JSON
   VERDICT=$(echo "${REVIEW_OUTPUT}" | node -e "
     let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
       try { const r=JSON.parse(d); console.log(r.verdict); }
       catch(e) { console.log('INVALID_JSON'); }
     });
   ")
   ```
   - If `verdict` is `"APPROVED"`: report approval with confidence and summary.
   - If `verdict` is `"REVISE"`: report issues found, list each issue with severity, file, line_range, description, and suggestion.
   - If JSON is invalid (`INVALID_JSON`): warn "External review returned invalid JSON" with stderr and continue.

   Regardless of the external review result, fall through to the manual review options below.

---

**Manual review options:**

Ask if user wants to trigger a code review:


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.

```
AskUserQuestion:
  question: "PR created. Run a code review before merge?"
  options:
    - label: "Skip review"
      description: "PR is ready — merge when CI passes"
    - label: "Self-review"
      description: "I'll review the diff in the PR myself"
    - label: "Request review"
      description: "Request review from a teammate"
```

**If "Request review":**
```bash
gh pr edit ${PR_NUMBER} --add-reviewer "${REVIEWER}"
```

**If "Self-review":**
Report the PR URL and suggest: "Review the diff at {url}/files"
</step>

<step name="track_shipping">
Update STATE.md to reflect the shipping action:

```bash
gsd_run query state.update "Last Activity" "$(date +%Y-%m-%d)"
gsd_run query state.update "Status" "Phase ${PHASE_NUMBER} shipped — PR #${PR_NUMBER}"
```

If `commit_docs` is true:
```bash
gsd_run query commit "docs(${padded_phase}): ship phase ${PHASE_NUMBER} — PR #${PR_NUMBER}" --files .planning/STATE.md
```
</step>

<step name="report">
```
───────────────────────────────────────────────────────────────

## ✓ Phase {X}: {Name} — Shipped

PR: #{number} ({url})
Branch: {branch} → ${BASE_BRANCH}
Commits: {count}
Verification: ✓ Passed
Requirements: {N} REQ-IDs addressed

Next steps:
- Review/approve PR
- Merge when CI passes
- /gsd:complete-milestone (if last phase in milestone)
- /gsd:progress (to see what's next)

───────────────────────────────────────────────────────────────
```
</step>

</process>

<offer_next>
After shipping:

- /gsd:complete-milestone — if all phases in milestone are done
- /gsd:progress — see overall project state
- /gsd:execute-phase {next} — continue to next phase
</offer_next>

<success_criteria>
- [ ] Preflight checks passed (verification, clean tree, branch, remote, gh)
- [ ] Branch pushed to remote
- [ ] PR created with rich auto-generated body
- [ ] STATE.md updated with shipping status
- [ ] User knows PR number and next steps
</success_criteria>
