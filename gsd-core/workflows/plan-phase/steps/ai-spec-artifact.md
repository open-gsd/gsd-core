AI integration activation is owned by the `ai-integration` capability's `plan:pre` step hook. The plan-phase host only discovers existing artifacts here so the planner can consume them; it must not read the capability's config key directly.

```bash
AI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-AI-SPEC.md 2>/dev/null | head -1)
AI_SPEC_PATH="${AI_SPEC_FILE}"
FRAMEWORK_LINE=""
if [ -n "$AI_SPEC_FILE" ]; then
  FRAMEWORK_LINE=$(grep "Selected Framework:" "${AI_SPEC_FILE}" | head -1)
fi
```

If `AI_SPEC_FILE` is non-empty, pass `AI_SPEC_PATH` and `FRAMEWORK_LINE` to the planner in step 8 so it can reference the AI design contract. If it is empty, the active `ai-integration` capability hook in step 5.6 handles any AI-system nudge or `/gsd:ai-integration-phase` dispatch.
