---
type: Fixed
pr: 1746
---
Windows: stop double-quoting $CLAUDE_PROJECT_DIR-anchored managed node hook paths during the #2979 legacy rewrite, which produced "\"$CLAUDE_PROJECT_DIR\"/..." and broke every node managed hook with MODULE_NOT_FOUND (PreToolUse-guard deadlock).
