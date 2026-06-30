# Reviewer Instances (#1517)

Custom reviewer instances for `/gsd:review`: run one model-capable adapter (e.g. OpenCode)
as several independent reviewer identities in a single review pass. Loaded lazily by
`gsd-core/workflows/review.md` when `review.reviewer_instances` is configured. See
[ADR-1517](../docs/adr/1517-reviewer-instances-config-surface.md) for the contract.

---

## Config shape

A `review.reviewer_instances` object under the `review` namespace. Each entry maps an
instance name to `{ cli, model?, agent? }`:

```json
{
  "review": {
    "reviewer_instances": {
      "opencode-deepseek": { "cli": "opencode", "model": "deepseek/deepseek-v4-pro", "agent": "review" },
      "opencode-mimo":     { "cli": "opencode", "model": "xiaomi/mimo-v2.5-pro" }
    },
    "default_reviewers": ["opencode-deepseek", "opencode-mimo", "codex"]
  }
}
```

- Instance name: `^[a-z0-9][a-z0-9-]*$`, must not equal a built-in slug. Validated at
  `config-set` time.
- `cli`: MUST be a known adapter (`KNOWN_REVIEWER_SLUGS`) — never an arbitrary shell command.
- `model`: opaque `provider/model` string, passed through verbatim. GSD does not parse it.
- `agent`: opaque string; honoured only by adapters with a native agent concept (OpenCode
  `--agent` in v1). Ignored by other adapters.

---

## Resolution rules (single source)

The canonical logic lives in `resolveReviewerSelection` / `normalizeReviewerInstances` in
`review-reviewer-selection.cjs`. Apply the SAME rules in the workflow so the two surfaces
cannot diverge (`DEFECT.GENERATIVE-FIX`; parity-locked in
`tests/review-reviewer-instances.test.cjs`).

1. Instances participate ONLY via `review.default_reviewers`. They never appear under `--all`
   or explicit `--<cli>` flags, and there are no per-instance CLI flags.
2. Expand instance references BEFORE the built-in-slug check: an entry that is a key in
   `review.reviewer_instances` is an **instance**; an entry that is a built-in slug is a
   **builtin**.
3. An instance is **available** iff its base `cli` is detected (e.g. `opencode-deepseek` is
   available iff `opencode` is available).
4. An entry that is NEITHER a defined instance NOR a built-in slug is a **hard error** (likely
   a typo'd instance name) — stop and report it. Do NOT silently drop it. (When
   `review.reviewer_instances` is absent entirely, fall back to the legacy unknown-slug
   warn-and-drop behaviour for backward compatibility.)
5. `model`/`agent`/instance-name are opaque: pass them as separate argv elements. They are
   NEVER interpolated into shell strings.

---

## Invocation

For each selected INSTANCE, invoke its base `cli` using the instance's own `model`/`agent` —
NOT the global `review.models.<cli>`. Each instance writes to its OWN per-instance output file
and runs as a distinct reviewer identity.

For an OpenCode-backed instance (the motivating adapter):

```bash
# $INSTANCE_MODEL / $INSTANCE_AGENT come from the instance spec; $INSTANCE_NAME is the
# reviewer identity (e.g. opencode-deepseek). --agent is OpenCode's native subagent flag;
# omit it when the instance has no agent.
if [ -n "$INSTANCE_AGENT" ] && [ "$INSTANCE_AGENT" != "null" ]; then
  cat /tmp/gsd-review-prompt-{phase}.md | opencode run --model "$INSTANCE_MODEL" --agent "$INSTANCE_AGENT" - 2>/dev/null > /tmp/gsd-review-${INSTANCE_NAME}-{phase}.md
else
  cat /tmp/gsd-review-prompt-{phase}.md | opencode run --model "$INSTANCE_MODEL" - 2>/dev/null > /tmp/gsd-review-${INSTANCE_NAME}-{phase}.md
fi
if [ ! -s /tmp/gsd-review-${INSTANCE_NAME}-{phase}.md ]; then
  echo "OpenCode review ($INSTANCE_NAME) failed or returned empty output." > /tmp/gsd-review-${INSTANCE_NAME}-{phase}.md
fi
```

For an instance backed by a DIFFERENT cli, reuse that cli's invocation block with two
substitutions: use the instance's `model` in place of the global `review.models.<cli>` value,
and write to `/tmp/gsd-review-${INSTANCE_NAME}-{phase}.md`. Only `opencode` honours an
`agent` field in v1; ignore `agent` for other adapters.

---

## REVIEWS.md contract

- **Frontmatter `reviewers:`** records the actual identities invoked. For a built-in slug use
  the slug (`opencode`); for an instance use the instance name (`opencode-deepseek`), so
  frontmatter distinguishes the independent voices. Example:
  `reviewers: [opencode-deepseek, opencode-mimo, codex]`.
- **Section headers:** each instance gets its OWN top-level section, headed with the base
  adapter's display name plus the instance name in parentheses:
  `## OpenCode Review (opencode-deepseek)`. Same-cli instances are never collapsed.
- **Shared-adapter caveat:** when ≥2 invoked instances share the same base `cli`, print a
  one-line caveat immediately after the frontmatter (before the first section), e.g.:
  `> Note: opencode-deepseek and opencode-mimo share the opencode adapter; their consensus is cross-model, not cross-tool.`
