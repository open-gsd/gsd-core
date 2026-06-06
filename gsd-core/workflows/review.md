<purpose>
Cross-AI peer review — invoke external AI CLIs to independently review phase plans.
Each CLI gets the same prompt (PROJECT.md context, phase plans, requirements) and
produces structured feedback. Results are combined into REVIEWS.md for the planner
to incorporate via --reviews flag.

This implements adversarial review: different AI models catch different blind spots.
A plan that survives review from 2-3 independent AI systems is more robust.
</purpose>

<process>

<step name="detect_clis">
Check which AI CLIs are available on the system:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS, local .claude/.codex runtime roots, or gsd-tools on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local (or the matching installer flags for your runtime)." >&2; exit 1; fi
# Check each CLI
command -v gemini >/dev/null 2>&1 && echo "gemini:available" || echo "gemini:missing"
command -v claude >/dev/null 2>&1 && echo "claude:available" || echo "claude:missing"
command -v codex >/dev/null 2>&1 && echo "codex:available" || echo "codex:missing"
command -v coderabbit >/dev/null 2>&1 && echo "coderabbit:available" || echo "coderabbit:missing"
command -v opencode >/dev/null 2>&1 && echo "opencode:available" || echo "opencode:missing"
command -v qwen >/dev/null 2>&1 && echo "qwen:available" || echo "qwen:missing"
command -v cursor-agent >/dev/null 2>&1 && echo "cursor:available" || echo "cursor:missing"
command -v agy >/dev/null 2>&1 && echo "antigravity:available" || echo "antigravity:missing"

# Check local model servers (OpenAI-compatible HTTP API — no CLI binary required)
OLLAMA_HOST=$(gsd_run query config-get review.ollama_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$OLLAMA_HOST" ] || [ "$OLLAMA_HOST" = "null" ]; then OLLAMA_HOST="http://localhost:11434"; fi
curl -s --max-time 2 "${OLLAMA_HOST}/v1/models" >/dev/null 2>&1 && echo "ollama:available" || echo "ollama:missing"

LM_STUDIO_HOST=$(gsd_run query config-get review.lm_studio_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LM_STUDIO_HOST" ] || [ "$LM_STUDIO_HOST" = "null" ]; then LM_STUDIO_HOST="http://localhost:1234"; fi
curl -s --max-time 2 "${LM_STUDIO_HOST}/v1/models" >/dev/null 2>&1 && echo "lm_studio:available" || echo "lm_studio:missing"

LLAMA_CPP_HOST=$(gsd_run query config-get review.llama_cpp_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LLAMA_CPP_HOST" ] || [ "$LLAMA_CPP_HOST" = "null" ]; then LLAMA_CPP_HOST="http://localhost:8080"; fi
curl -s --max-time 2 "${LLAMA_CPP_HOST}/v1/models" >/dev/null 2>&1 && echo "llama_cpp:available" || echo "llama_cpp:missing"
```

Parse flags from `$ARGUMENTS`:
- `--gemini` → include Gemini
- `--claude` → include Claude
- `--codex` → include Codex
- `--coderabbit` → include CodeRabbit
- `--opencode` → include OpenCode
- `--qwen` → include Qwen Code
- `--cursor` → include Cursor
- `--agy` or `--antigravity` → include Antigravity CLI
- `--ollama` → include Ollama (local server, OpenAI-compatible)
- `--lm-studio` → include LM Studio (local server, OpenAI-compatible)
- `--llama-cpp` → include llama.cpp (local server, OpenAI-compatible)
- `--all` → include all available (CLIs + running local servers)
- No flags → if `review.default_reviewers` is set, include only configured reviewers that are detected; otherwise include all available

Reviewer-selection precedence:
1. Individual reviewer flags (`--gemini`, `--codex`, etc.)
2. `--all`
3. `review.default_reviewers`
4. No key + no flags → all detected reviewers

`review.default_reviewers` behavior:
- Value must be a non-empty array of slug strings (configured via `gsd config-set review.default_reviewers '["gemini","codex"]'`)
- Unknown slugs warn and are ignored
- Known-but-undetected slugs emit an info note and are ignored
- If all configured reviewers are unavailable, fail with an actionable message

If no CLIs are available:
```
No external AI CLIs found. Install at least one:
- gemini: https://github.com/google-gemini/gemini-cli
- codex: https://github.com/openai/codex
- claude: https://github.com/anthropics/claude-code
- opencode: https://opencode.ai (leverages GitHub Copilot subscription models)
- qwen: https://github.com/nicepkg/qwen-code (Alibaba Qwen models)
- cursor: https://cursor.com (Cursor IDE agent mode)
- agy: curl -fsSL https://antigravity.google/cli/install.sh | bash (Antigravity CLI — free with Google credentials)

Then run /gsd:review again.
```
Exit.

Determine which CLI to skip based on the current runtime environment:

```bash
# Environment-based runtime detection (priority order)
if [ "$ANTIGRAVITY_AGENT" = "1" ]; then
  # Antigravity is a separate client — all CLIs are external, skip none
  SELF_CLI="none"
elif [ -n "$CURSOR_SESSION_ID" ]; then
  # Running inside Cursor agent — skip cursor for independence
  SELF_CLI="cursor"
elif [ -n "$CLAUDE_CODE_ENTRYPOINT" ]; then
  # Running inside Claude Code CLI — skip claude for independence
  SELF_CLI="claude"
else
  # Other environments (Gemini CLI, Codex CLI, etc.)
  # Fall back to AI self-identification to decide which CLI to skip
  SELF_CLI="auto"
fi
```

Rules:
- If `SELF_CLI="none"` → invoke ALL available CLIs (no skip)
- If `SELF_CLI="claude"` → skip claude, use gemini/codex
- If `SELF_CLI="auto"` → the executing AI identifies itself and skips its own CLI
- At least one DIFFERENT CLI must be available for the review to proceed.
</step>

<step name="gather_context">
Collect phase artifacts for the review prompt:

```bash
INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Read from init: `phase_dir`, `phase_number`, `padded_phase`.

Then read:
1. `.planning/PROJECT.md` (first 80 lines — project context)
2. Phase section from `.planning/ROADMAP.md`
3. All `*-PLAN.md` files in the phase directory
4. `*-CONTEXT.md` if present (user decisions)
5. `*-RESEARCH.md` if present (domain research)
6. `.planning/REQUIREMENTS.md` (requirements this phase addresses)
</step>

<step name="build_prompt">
Build a structured review prompt:

```markdown
# Cross-AI Plan Review Request

You are reviewing implementation plans for a software project phase.
Provide structured feedback on plan quality, completeness, and risks.

## Project Context
{first 80 lines of PROJECT.md}

## Phase {N}: {phase name}
### Roadmap Section
{roadmap phase section}

### Requirements Addressed
{requirements for this phase}

### User Decisions (CONTEXT.md)
{context if present}

### Research Findings
{research if present}

### Plans to Review
{all PLAN.md contents}

## Review Instructions

Analyze each plan and provide:

1. **Summary** — One-paragraph assessment
2. **Strengths** — What's well-designed (bullet points)
3. **Concerns** — Potential issues, gaps, risks (bullet points with severity: HIGH/MEDIUM/LOW)
4. **Suggestions** — Specific improvements (bullet points)
5. **Risk Assessment** — Overall risk level (LOW/MEDIUM/HIGH) with justification

Focus on:
- Missing edge cases or error handling
- Dependency ordering issues
- Scope creep or over-engineering
- Security considerations
- Performance implications
- Whether the plans actually achieve the phase goals

Output your review in markdown format.
```

Write to a temp file: `/tmp/gsd-review-prompt-{phase}.md`

Also write individual section files so the budget tool can re-trim per reviewer:

```bash
# Write individual section files for per-reviewer budget trimming
# These are always written so reviewers with a budget can invoke prompt-budget
cp "$INSTRUCTIONS_BLOCK_FILE" "/tmp/gsd-review-${PHASE}-instructions.md"
cp "$ROADMAP_SECTION_FILE" "/tmp/gsd-review-${PHASE}-roadmap.md"

# Plan files: copy each PLAN.md to a predictable numbered path
PLAN_INDEX=0
for PLAN_FILE in "${PHASE_DIR}"/*-PLAN.md; do
  PADDED_IDX=$(printf '%02d' "$PLAN_INDEX")
  cp "$PLAN_FILE" "/tmp/gsd-review-${PHASE}-plan-${PADDED_IDX}.md"
  PLAN_INDEX=$((PLAN_INDEX + 1))
done

# Optional section files (only if content was included in the combined prompt)
if [ -f ".planning/PROJECT.md" ]; then
  cp .planning/PROJECT.md "/tmp/gsd-review-${PHASE}-project.md"
fi
if ls "${PHASE_DIR}/"*"-CONTEXT.md" >/dev/null 2>&1; then
  cat "${PHASE_DIR}/"*"-CONTEXT.md" > "/tmp/gsd-review-${PHASE}-context.md"
fi
if ls "${PHASE_DIR}/"*"-RESEARCH.md" >/dev/null 2>&1; then
  cat "${PHASE_DIR}/"*"-RESEARCH.md" > "/tmp/gsd-review-${PHASE}-research.md"
fi
if [ -f ".planning/REQUIREMENTS.md" ]; then
  cp .planning/REQUIREMENTS.md "/tmp/gsd-review-${PHASE}-requirements.md"
fi
```

Note: The variable names above (`INSTRUCTIONS_BLOCK_FILE`, `ROADMAP_SECTION_FILE`, `PHASE_DIR`, `PHASE`) reference the variables already established during prompt assembly. In practice the AI implementing this step writes the instruction and roadmap blocks to temp files while assembling the combined prompt, then copies those same temp files to the per-reviewer section paths. If the assembled prompt was built inline (string concatenation rather than file-by-file), write each section to the corresponding path after writing the combined file.
</step>

<step name="invoke_reviewers">
Read model preferences from planning config. Null/missing values fall back to CLI defaults.

```bash
# JSON scalars from gsd-tools.cjs query; use jq -r to strip JSON string quotes (install jq if missing)
GEMINI_MODEL=$(gsd_run query config-get review.models.gemini 2>/dev/null | jq -r '.' 2>/dev/null || true)
CLAUDE_MODEL=$(gsd_run query config-get review.models.claude 2>/dev/null | jq -r '.' 2>/dev/null || true)
CODEX_MODEL=$(gsd_run query config-get review.models.codex 2>/dev/null | jq -r '.' 2>/dev/null || true)
OPENCODE_MODEL=$(gsd_run query config-get review.models.opencode 2>/dev/null | jq -r '.' 2>/dev/null || true)
# review.models.agy is reserved for future model-pinning support; agy selects its model internally
AGY_MODEL=$(gsd_run query config-get review.models.agy 2>/dev/null | jq -r '.' 2>/dev/null || true)
```

For each selected CLI, invoke in sequence (not parallel — avoid rate limits):

**Gemini:**
```bash
if [ -n "$GEMINI_MODEL" ] && [ "$GEMINI_MODEL" != "null" ]; then
  cat /tmp/gsd-review-prompt-{phase}.md | gemini -m "$GEMINI_MODEL" -p - 2>/dev/null > /tmp/gsd-review-gemini-{phase}.md
else
  cat /tmp/gsd-review-prompt-{phase}.md | gemini -p - 2>/dev/null > /tmp/gsd-review-gemini-{phase}.md
fi
```

**Claude (separate session):**
```bash
if [ -n "$CLAUDE_MODEL" ] && [ "$CLAUDE_MODEL" != "null" ]; then
  cat /tmp/gsd-review-prompt-{phase}.md | claude --model "$CLAUDE_MODEL" -p - 2>/dev/null > /tmp/gsd-review-claude-{phase}.md
else
  cat /tmp/gsd-review-prompt-{phase}.md | claude -p - 2>/dev/null > /tmp/gsd-review-claude-{phase}.md
fi
```

**Codex:**
```bash
if [ -n "$CODEX_MODEL" ] && [ "$CODEX_MODEL" != "null" ]; then
  cat /tmp/gsd-review-prompt-{phase}.md | codex exec --model "$CODEX_MODEL" --skip-git-repo-check - 2>/dev/null > /tmp/gsd-review-codex-{phase}.md
else
  cat /tmp/gsd-review-prompt-{phase}.md | codex exec --skip-git-repo-check - 2>/dev/null > /tmp/gsd-review-codex-{phase}.md
fi
```

**CodeRabbit:**

Note: CodeRabbit reviews the current git diff/working tree — it does not accept a prompt or model flag. It may take up to 5 minutes. Use `timeout: 360000` on the Bash tool call.

```bash
coderabbit review --prompt-only 2>/dev/null > /tmp/gsd-review-coderabbit-{phase}.md
```

**OpenCode (via GitHub Copilot):**
```bash
if [ -n "$OPENCODE_MODEL" ] && [ "$OPENCODE_MODEL" != "null" ]; then
  cat /tmp/gsd-review-prompt-{phase}.md | opencode run --model "$OPENCODE_MODEL" - 2>/dev/null > /tmp/gsd-review-opencode-{phase}.md
else
  cat /tmp/gsd-review-prompt-{phase}.md | opencode run - 2>/dev/null > /tmp/gsd-review-opencode-{phase}.md
fi
if [ ! -s /tmp/gsd-review-opencode-{phase}.md ]; then
  echo "OpenCode review failed or returned empty output." > /tmp/gsd-review-opencode-{phase}.md
fi
```

**Qwen Code:**
```bash
cat /tmp/gsd-review-prompt-{phase}.md | qwen - 2>/dev/null > /tmp/gsd-review-qwen-{phase}.md
if [ ! -s /tmp/gsd-review-qwen-{phase}.md ]; then
  echo "Qwen review failed or returned empty output." > /tmp/gsd-review-qwen-{phase}.md
fi
```

**Cursor:**
```bash
# cursor-agent is a SEPARATE binary from the `cursor` IDE launcher; print mode (-p) takes the
# prompt as an ARGUMENT, not stdin. A full review prompt can exceed the OS argument limit, so
# reference the prompt file by path rather than inlining it. Capture stderr so a failure is
# diagnosable instead of a silent empty result.
CURSOR_PROMPT_ARG="Read the file at /tmp/gsd-review-prompt-{phase}.md in full and carry out the review request it contains. Output only the resulting markdown review. Do not edit any files."
cursor-agent -p --mode ask --trust --output-format text "$CURSOR_PROMPT_ARG" 2>/tmp/gsd-review-cursor-{phase}.err > /tmp/gsd-review-cursor-{phase}.md
if [ ! -s /tmp/gsd-review-cursor-{phase}.md ]; then
  echo "Cursor review failed or returned empty output. stderr:" > /tmp/gsd-review-cursor-{phase}.md
  cat /tmp/gsd-review-cursor-{phase}.err >> /tmp/gsd-review-cursor-{phase}.md
fi
```

**Antigravity CLI:**

**Maintainer note — why this block has three layers (last updated against agy 1.0.2):**

`agy -p` (the `--print` non-interactive flag) works correctly on macOS and Linux: it sends the
prompt, receives the model response, and writes it to stdout. On **native Windows** it silently
produces no stdout output despite the API call succeeding — a bug in `text_drip.go`'s non-TTY
flush path, tracked at https://github.com/google-antigravity/antigravity-cli/issues/27466 and
still open as of agy 1.0.2.

Regardless of platform, `agy` always persists the full exchange to a transcript file on disk.
The transcript fallback (Step 2 below) reads that file directly, giving Windows users full review
coverage without any extra tooling. This pattern was first documented by the community MCP bridge
at https://github.com/SinanTufekci/Claude-Code-Antigravity-CLI-MCP-Server — we inline the same
logic here in pure bash/jq so no additional dependency is required.

**Stale-response guard (why the pre-flight watermark matters):**
Without a watermark, the fallback would read the last `PLANNER_RESPONSE` entry in the transcript
regardless of when it was written — including entries from a previous invocation in the same
workspace. To prevent that, we record the transcript's line count *before* calling `agy -p`. In
the fallback, we only read lines appended after that count. If no new lines were written (agy
failed before producing a response), `_AGY_RESULT` is empty and Step 3 fires — never stale. If
the conv-id changed (agy started a fresh session), all lines in the new file are new and we use
skip=0.

**If the upstream stdout bug is fixed** (check the issue above): Step 2 silently becomes
unreachable; stdout is non-empty and Step 1 handles it. No code change needed.

**If the transcript paths change** in a future `agy` release: Step 2 silently becomes a no-op
and Step 3 fires with a clear error message in REVIEWS.md. No silent corruption. To debug:
- `~/.gemini/antigravity-cli/cache/last_conversations.json` — workspace → conv-id map
- `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
  Filter: `source=="MODEL"`, `status=="DONE"`, `type=="PLANNER_RESPONSE"`, take the last match's `content` field.

Invocation specifics (verified agy 1.0.0, macOS arm64 and Linux amd64):
- `-p` takes the prompt as a **flag value** — `echo X | agy -p` errors with "flag needs an argument: -p"
- `--print-timeout` defaults to 5m, aligning with this workflow's global timeout
- No `-m` / `--model` flag — agy selects the model internally

```bash
# Pre-flight: snapshot the transcript watermark before invoking agy.
# Must run BEFORE agy -p — this is what prevents the fallback from reading a stale prior response.
_AGY_WS=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_AGY_CACHE="$HOME/.gemini/antigravity-cli/cache/last_conversations.json"
_AGY_MARK_CONV=""
_AGY_MARK_LINES=0
if [ -f "$_AGY_CACHE" ]; then
  _AGY_MARK_CONV=$(jq -r --arg ws "$_AGY_WS" '
    .[$ws] //
    (to_entries
     | map(select(.key | ascii_downcase == ($ws | ascii_downcase)))
     | first | .value) //
    empty
  ' "$_AGY_CACHE" 2>/dev/null)
  if [ -n "$_AGY_MARK_CONV" ] && [ "$_AGY_MARK_CONV" != "null" ]; then
    _AGY_MARK_TX="$HOME/.gemini/antigravity-cli/brain/${_AGY_MARK_CONV}/.system_generated/logs/transcript.jsonl"
    [ -f "$_AGY_MARK_TX" ] && _AGY_MARK_LINES=$(wc -l < "$_AGY_MARK_TX" | tr -d ' ')
  fi
fi

# Step 1 — primary invocation: stdout works on macOS, Linux, and WSL.
# Bound the run with agy's OWN `--print-timeout` (issue #687). On a large,
# file-path-rich prompt agy's agentic Cascade can loop on its code_search/grep
# steps and never converge; `--print-timeout` is agy's native cap for print mode
# (defaults to 5m — see maintainer note above), so we pass it explicitly to let a
# stalled run self-terminate through the tool's own mechanism. A non-zero exit
# (timeout or crash) discards any partial output so the Step 2 transcript fallback
# / Step 3 stub take over.
agy --print-timeout 300s -p "$(cat /tmp/gsd-review-prompt-{phase}.md)" 2>/dev/null > /tmp/gsd-review-antigravity-{phase}.md
_AGY_RC=$?
if [ "$_AGY_RC" -ne 0 ]; then
  : > /tmp/gsd-review-antigravity-{phase}.md
fi

# Step 2 — transcript fallback: catches Windows agy -p stdout bug (and any future stdout-silent edge cases).
# Reads only lines appended AFTER the pre-flight watermark. If agy failed before writing a new response,
# _AGY_RESULT is empty and Step 3 fires — no stale content can leak through.
# Undocumented paths, verified agy 1.0.0–1.0.2. See maintainer note above if these break.
if [ ! -s /tmp/gsd-review-antigravity-{phase}.md ]; then
  if [ -f "$_AGY_CACHE" ]; then
    _AGY_CONV=$(jq -r --arg ws "$_AGY_WS" '
      .[$ws] //
      (to_entries
       | map(select(.key | ascii_downcase == ($ws | ascii_downcase)))
       | first | .value) //
      empty
    ' "$_AGY_CACHE" 2>/dev/null)
    if [ -n "$_AGY_CONV" ] && [ "$_AGY_CONV" != "null" ]; then
      _AGY_TX="$HOME/.gemini/antigravity-cli/brain/${_AGY_CONV}/.system_generated/logs/transcript.jsonl"
      if [ -f "$_AGY_TX" ]; then
        # If conv-id changed, agy started a new session — all lines are new, skip 0.
        # If same conv-id, only read lines beyond the watermark.
        [ "$_AGY_CONV" = "$_AGY_MARK_CONV" ] && _AGY_SKIP=$_AGY_MARK_LINES || _AGY_SKIP=0
        _AGY_RESULT=$(tail -n +"$((_AGY_SKIP + 1))" "$_AGY_TX" 2>/dev/null | \
          jq -r 'select(.source=="MODEL" and .status=="DONE" and .type=="PLANNER_RESPONSE") | .content' \
          2>/dev/null | tail -1)
        [ -n "$_AGY_RESULT" ] && echo "$_AGY_RESULT" > /tmp/gsd-review-antigravity-{phase}.md
      fi
    fi
  fi
fi

# Step 3 — final guard: both approaches yielded nothing (auth error, first-run setup, path schema changed, etc.)
if [ ! -s /tmp/gsd-review-antigravity-{phase}.md ]; then
  echo "Antigravity review failed or returned empty output." > /tmp/gsd-review-antigravity-{phase}.md
fi
```

**Ollama (local, OpenAI-compatible):**

Read host and model from config. All three local backends share the same `/v1/chat/completions` endpoint — only host and model differ. Use `jq --rawfile` to safely encode the multi-line prompt as JSON without shell-escaping issues.

```bash
# Shared helper: apply prompt-budget trimming for local reviewers
prepare_trimmed_prompt_for_reviewer() {
  REVIEWER_KEY="$1"
  REVIEWER_BUDGET="$2"
  OUTPUT_PROMPT="$3"
  OUTPUT_META="$4"

  [ -z "$REVIEWER_BUDGET" ] && return 0
  [ "$REVIEWER_BUDGET" = "null" ] && return 0
  [ "$REVIEWER_BUDGET" = "0" ] && return 0

  PLAN_FILE_ARGS=""
  for p in /tmp/gsd-review-{phase}-plan-*.md; do
    [ -f "$p" ] && PLAN_FILE_ARGS="$PLAN_FILE_ARGS --plan-file $p"
  done
  PROJECT_ARG=""
  [ -f "/tmp/gsd-review-{phase}-project.md" ] && PROJECT_ARG="--project-file /tmp/gsd-review-{phase}-project.md"
  CONTEXT_ARG=""
  [ -f "/tmp/gsd-review-{phase}-context.md" ] && CONTEXT_ARG="--context-file /tmp/gsd-review-{phase}-context.md"
  RESEARCH_ARG=""
  [ -f "/tmp/gsd-review-{phase}-research.md" ] && RESEARCH_ARG="--research-file /tmp/gsd-review-{phase}-research.md"
  REQUIREMENTS_ARG=""
  [ -f "/tmp/gsd-review-{phase}-requirements.md" ] && REQUIREMENTS_ARG="--requirements-file /tmp/gsd-review-{phase}-requirements.md"

  gsd_run query prompt-budget \
    --budget "$REVIEWER_BUDGET" \
    --instructions-file "/tmp/gsd-review-{phase}-instructions.md" \
    --roadmap-file "/tmp/gsd-review-{phase}-roadmap.md" \
    $PLAN_FILE_ARGS $PROJECT_ARG $CONTEXT_ARG $RESEARCH_ARG $REQUIREMENTS_ARG \
    --output-prompt "$OUTPUT_PROMPT" \
    --output-metadata "$OUTPUT_META"
  return $?
}

# Resolve prompt budget for Ollama: per-reviewer override > global default > null
OLLAMA_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens_per_reviewer.ollama 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
if [ -z "$OLLAMA_REVIEWER_BUDGET" ] || [ "$OLLAMA_REVIEWER_BUDGET" = "null" ]; then
  OLLAMA_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
fi

# Apply budget trim for Ollama if a budget is configured
OLLAMA_PROMPT_FILE="/tmp/gsd-review-prompt-{phase}.md"
OLLAMA_SKIP=0
if [ -n "$OLLAMA_REVIEWER_BUDGET" ] && [ "$OLLAMA_REVIEWER_BUDGET" != "null" ] && [ "$OLLAMA_REVIEWER_BUDGET" != "0" ]; then
  OLLAMA_TRIMMED_PROMPT="/tmp/gsd-review-prompt-{phase}-ollama.md"
  OLLAMA_TRIM_META="/tmp/gsd-review-prompt-{phase}-ollama.metadata.json"
  prepare_trimmed_prompt_for_reviewer "ollama" "$OLLAMA_REVIEWER_BUDGET" "$OLLAMA_TRIMMED_PROMPT" "$OLLAMA_TRIM_META"
  OLLAMA_EXIT=$?
  if [ $OLLAMA_EXIT -ne 0 ]; then
    if [ $OLLAMA_EXIT -eq 2 ] || [ $OLLAMA_EXIT -eq 11 ]; then
      echo "WARNING: prompt budget for ollama (${OLLAMA_REVIEWER_BUDGET} tokens) is too small for the minimum review set. Skipping Ollama reviewer." >&2
    else
      echo "WARNING: prompt-budget returned unexpected exit code ${OLLAMA_EXIT} for ollama. Skipping Ollama reviewer." >&2
    fi
    OLLAMA_SKIP=1
  else
    OLLAMA_PROMPT_FILE="$OLLAMA_TRIMMED_PROMPT"
  fi
fi

if [ "$OLLAMA_SKIP" != "1" ]; then
OLLAMA_HOST=$(gsd_run query config-get review.ollama_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$OLLAMA_HOST" ] || [ "$OLLAMA_HOST" = "null" ]; then OLLAMA_HOST="http://localhost:11434"; fi
OLLAMA_MODEL=$(gsd_run query config-get review.models.ollama 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$OLLAMA_MODEL" ] || [ "$OLLAMA_MODEL" = "null" ]; then
  OLLAMA_MODEL=$(curl -s --max-time 2 "${OLLAMA_HOST}/v1/models" 2>/dev/null | jq -r '.data[0].id // "llama3"' 2>/dev/null || echo "llama3")
fi
jq -n --rawfile content "$OLLAMA_PROMPT_FILE" \
  --arg model "$OLLAMA_MODEL" \
  '{model: $model, messages: [{role: "user", content: $content}]}' | \
  curl -s --max-time 120 -X POST "${OLLAMA_HOST}/v1/chat/completions" \
    -H "Content-Type: application/json" -d @- 2>/dev/null | \
  jq -r '.choices[0].message.content // "Ollama review failed or returned empty output."' \
  > /tmp/gsd-review-ollama-{phase}.md
if [ ! -s /tmp/gsd-review-ollama-{phase}.md ]; then
  echo "Ollama review failed or returned empty output." > /tmp/gsd-review-ollama-{phase}.md
fi
fi
```

**LM Studio (local, OpenAI-compatible):**
```bash
# Resolve prompt budget for LM Studio: per-reviewer override > global default > null
LM_STUDIO_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens_per_reviewer.lm_studio 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
if [ -z "$LM_STUDIO_REVIEWER_BUDGET" ] || [ "$LM_STUDIO_REVIEWER_BUDGET" = "null" ]; then
  LM_STUDIO_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
fi

# Apply budget trim for LM Studio if a budget is configured
LM_STUDIO_PROMPT_FILE="/tmp/gsd-review-prompt-{phase}.md"
LM_STUDIO_SKIP=0
if [ -n "$LM_STUDIO_REVIEWER_BUDGET" ] && [ "$LM_STUDIO_REVIEWER_BUDGET" != "null" ] && [ "$LM_STUDIO_REVIEWER_BUDGET" != "0" ]; then
  LM_STUDIO_TRIMMED_PROMPT="/tmp/gsd-review-prompt-{phase}-lm_studio.md"
  LM_STUDIO_TRIM_META="/tmp/gsd-review-prompt-{phase}-lm_studio.metadata.json"
  prepare_trimmed_prompt_for_reviewer "lm_studio" "$LM_STUDIO_REVIEWER_BUDGET" "$LM_STUDIO_TRIMMED_PROMPT" "$LM_STUDIO_TRIM_META"
  LM_STUDIO_EXIT=$?
  if [ $LM_STUDIO_EXIT -ne 0 ]; then
    if [ $LM_STUDIO_EXIT -eq 2 ] || [ $LM_STUDIO_EXIT -eq 11 ]; then
      echo "WARNING: prompt budget for lm_studio (${LM_STUDIO_REVIEWER_BUDGET} tokens) is too small for the minimum review set. Skipping LM Studio reviewer." >&2
    else
      echo "WARNING: prompt-budget returned unexpected exit code ${LM_STUDIO_EXIT} for lm_studio. Skipping LM Studio reviewer." >&2
    fi
    LM_STUDIO_SKIP=1
  else
    LM_STUDIO_PROMPT_FILE="$LM_STUDIO_TRIMMED_PROMPT"
  fi
fi

if [ "$LM_STUDIO_SKIP" != "1" ]; then
LM_STUDIO_HOST=$(gsd_run query config-get review.lm_studio_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LM_STUDIO_HOST" ] || [ "$LM_STUDIO_HOST" = "null" ]; then LM_STUDIO_HOST="http://localhost:1234"; fi
LM_STUDIO_MODEL=$(gsd_run query config-get review.models.lm_studio 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LM_STUDIO_MODEL" ] || [ "$LM_STUDIO_MODEL" = "null" ]; then
  LM_STUDIO_MODEL=$(curl -s --max-time 2 "${LM_STUDIO_HOST}/v1/models" 2>/dev/null | jq -r '.data[0].id // "local-model"' 2>/dev/null || echo "local-model")
fi
LM_STUDIO_RESPONSE=$(jq -n --rawfile content "$LM_STUDIO_PROMPT_FILE" \
  --arg model "$LM_STUDIO_MODEL" \
  '{model: $model, messages: [{role: "user", content: $content}]}' | \
  curl -s --max-time 120 -X POST "${LM_STUDIO_HOST}/v1/chat/completions" \
    -H "Content-Type: application/json" -d @- 2>/dev/null)
LM_STUDIO_ACTUAL_MODEL=$(echo "$LM_STUDIO_RESPONSE" | jq -r '.model // ""' 2>/dev/null || echo "")
if [ -n "$LM_STUDIO_ACTUAL_MODEL" ] && [ "$LM_STUDIO_ACTUAL_MODEL" != "null" ] && [ "$LM_STUDIO_ACTUAL_MODEL" != "$LM_STUDIO_MODEL" ]; then
  echo "Warning: LM Studio served model '$LM_STUDIO_ACTUAL_MODEL' but '$LM_STUDIO_MODEL' was requested. Review may be from a different model." >&2
fi
LM_STUDIO_CONTENT=$(echo "$LM_STUDIO_RESPONSE" | jq -r '.choices[0].message.content // ""' 2>/dev/null || echo "")
if [ -n "$LM_STUDIO_CONTENT" ]; then
  echo "$LM_STUDIO_CONTENT" > /tmp/gsd-review-lm_studio-{phase}.md
else
  echo "Warning: LM Studio returned empty content — skipping review." >&2
fi
fi
```

**llama.cpp (local, OpenAI-compatible):**
```bash
# Resolve prompt budget for llama.cpp: per-reviewer override > global default > null
LLAMA_CPP_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens_per_reviewer.llama_cpp 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
if [ -z "$LLAMA_CPP_REVIEWER_BUDGET" ] || [ "$LLAMA_CPP_REVIEWER_BUDGET" = "null" ]; then
  LLAMA_CPP_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
fi

# Apply budget trim for llama.cpp if a budget is configured
LLAMA_CPP_PROMPT_FILE="/tmp/gsd-review-prompt-{phase}.md"
LLAMA_CPP_SKIP=0
if [ -n "$LLAMA_CPP_REVIEWER_BUDGET" ] && [ "$LLAMA_CPP_REVIEWER_BUDGET" != "null" ] && [ "$LLAMA_CPP_REVIEWER_BUDGET" != "0" ]; then
  LLAMA_CPP_TRIMMED_PROMPT="/tmp/gsd-review-prompt-{phase}-llama_cpp.md"
  LLAMA_CPP_TRIM_META="/tmp/gsd-review-prompt-{phase}-llama_cpp.metadata.json"
  prepare_trimmed_prompt_for_reviewer "llama_cpp" "$LLAMA_CPP_REVIEWER_BUDGET" "$LLAMA_CPP_TRIMMED_PROMPT" "$LLAMA_CPP_TRIM_META"
  LLAMA_CPP_EXIT=$?
  if [ $LLAMA_CPP_EXIT -ne 0 ]; then
    if [ $LLAMA_CPP_EXIT -eq 2 ] || [ $LLAMA_CPP_EXIT -eq 11 ]; then
      echo "WARNING: prompt budget for llama_cpp (${LLAMA_CPP_REVIEWER_BUDGET} tokens) is too small for the minimum review set. Skipping llama.cpp reviewer." >&2
    else
      echo "WARNING: prompt-budget returned unexpected exit code ${LLAMA_CPP_EXIT} for llama_cpp. Skipping llama.cpp reviewer." >&2
    fi
    LLAMA_CPP_SKIP=1
  else
    LLAMA_CPP_PROMPT_FILE="$LLAMA_CPP_TRIMMED_PROMPT"
  fi
fi

if [ "$LLAMA_CPP_SKIP" != "1" ]; then
LLAMA_CPP_HOST=$(gsd_run query config-get review.llama_cpp_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LLAMA_CPP_HOST" ] || [ "$LLAMA_CPP_HOST" = "null" ]; then LLAMA_CPP_HOST="http://localhost:8080"; fi
LLAMA_CPP_MODEL=$(gsd_run query config-get review.models.llama_cpp 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LLAMA_CPP_MODEL" ] || [ "$LLAMA_CPP_MODEL" = "null" ]; then
  LLAMA_CPP_MODEL=$(curl -s --max-time 2 "${LLAMA_CPP_HOST}/v1/models" 2>/dev/null | jq -r '.data[0].id // "local-model"' 2>/dev/null || echo "local-model")
fi
LLAMA_CPP_CONTENT=$(jq -n --rawfile content "$LLAMA_CPP_PROMPT_FILE" \
  --arg model "$LLAMA_CPP_MODEL" \
  '{model: $model, messages: [{role: "user", content: $content}]}' | \
  curl -s --max-time 120 -X POST "${LLAMA_CPP_HOST}/v1/chat/completions" \
    -H "Content-Type: application/json" -d @- 2>/dev/null | \
  jq -r '.choices[0].message.content // ""' 2>/dev/null || echo "")
if [ -n "$LLAMA_CPP_CONTENT" ]; then
  echo "$LLAMA_CPP_CONTENT" > /tmp/gsd-review-llama_cpp-{phase}.md
else
  echo "Warning: llama.cpp returned empty content — skipping review." >&2
fi
fi
```

If a CLI or local server fails, log the error and continue with remaining reviewers.

Display progress:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► CROSS-AI REVIEW — Phase {N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Reviewing with {CLI}... done ✓
◆ Reviewing with {CLI}... done ✓
```
</step>

<step name="write_reviews">
Combine all review responses into `{phase_dir}/{padded_phase}-REVIEWS.md`:

After all reviewers complete, collect trim metadata files written during the run. For each reviewer that was trimmed (i.e. a `.metadata.json` file exists and `hardFailed` or `omitted` is non-empty, or `projectMdShrunk` is true, or `planTruncationPct > 0`), include a `trimmed_reviewers` block in the frontmatter. Omit the key entirely if no reviewer was trimmed.

```markdown
---
phase: {N}
reviewers: [gemini, claude, codex, coderabbit, opencode, qwen, cursor, antigravity, ollama, lm_studio, llama_cpp]  # populate at runtime with only the reviewers actually invoked
reviewed_at: {ISO timestamp}
plans_reviewed: [{list of PLAN.md files}]
trimmed_reviewers:        # only present if at least one reviewer was trimmed
  ollama:
    budget: 6000
    effective_budget: 5400
    estimated_tokens: 5380
    omitted: [context, research]
    project_md_shrunk: true
    plan_truncation_pct: 22
    hard_failed: false
    note_injected: true
---

# Cross-AI Plan Review — Phase {N}

## Gemini Review

{gemini review content}

---

## Claude Review

{claude review content}

---

## Codex Review

{codex review content}

---

## CodeRabbit Review

{coderabbit review content}

---

## OpenCode Review

{opencode review content}

---

## Qwen Review

{qwen review content}

---

## Cursor Review

{cursor review content}

---

## Antigravity Review

{antigravity review content}

---

## Ollama Review

{ollama review content}

---

## LM Studio Review

{lm_studio review content}

---

## llama.cpp Review

{llama_cpp review content}

---

## Consensus Summary

{synthesize common concerns across all reviewers}

### Agreed Strengths
{strengths mentioned by 2+ reviewers}

### Agreed Concerns
{concerns raised by 2+ reviewers — highest priority}

### Divergent Views
{where reviewers disagreed — worth investigating}
```

Commit:
```bash
gsd_run query commit "docs: cross-AI review for phase {N}" --files {phase_dir}/{padded_phase}-REVIEWS.md
```
</step>

<step name="present_results">
Display summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► REVIEW COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase {N} reviewed by {count} AI systems.

Consensus concerns:
{top 3 shared concerns}

Full review: {padded_phase}-REVIEWS.md

To incorporate feedback into planning:
  /gsd:plan-phase {N} --reviews
```

Clean up temp files.
</step>

</process>

<success_criteria>
- [ ] At least one external CLI invoked successfully
- [ ] REVIEWS.md written with structured feedback
- [ ] Consensus summary synthesized from multiple reviewers
- [ ] Temp files cleaned up
- [ ] User knows how to use feedback (/gsd:plan-phase --reviews)
</success_criteria>
