---
id: 46
title: Security Hardening
group: v1.27 Features
---

**Purpose:** Defense-in-depth security for GSD's planning artifacts. Because GSD generates markdown files that become LLM system prompts, user-controlled text flowing into these files is a potential indirect prompt injection vector.

**Components:**

**1. Centralized Security Module** (`security.cjs`)
- Path traversal prevention — validates file paths resolve within the project directory
- Prompt injection detection — scans for known injection patterns in user-supplied text
- Safe JSON parsing — catches malformed input before state corruption
- Field name validation — prevents injection through config field names
- Shell argument validation — sanitizes user text before shell interpolation

**2. Prompt Injection Guard Hook** (`gsd-prompt-guard.js`)
PreToolUse hook that scans Write/Edit calls targeting `.planning/` for injection patterns. Advisory-only — logs detection for awareness without blocking legitimate operations.

**3. Workflow Guard Hook** (`gsd-workflow-guard.js`)
PreToolUse hook that detects when Claude attempts file edits outside a GSD workflow context. Advises using `/gsd-quick` or `/gsd-fast` instead of direct edits. Configurable via `hooks.workflow_guard` (default: false).

**4. CI-Ready Injection Scanner** (`prompt-injection-scan.security.test.cjs`)
Test suite that scans all agent, workflow, and command files for embedded injection vectors.

**5. Agent Isolation and Model Guard Hook** (`gsd-agent-isolation-guard.js`)
PreToolUse hook. Besides the isolation-parameter check, on Claude Code it compares the `model` passed to `Agent()`/`Task()` for `gsd-executor`, `gsd-verifier`, `gsd-plan-checker` and `gsd-planner` with the resolved model (tier level: `claude-sonnet-4-6` equals `sonnet`). `hooks.agent_model_guard`: `"warn"` (default; any other stored value behaves as warn) adds model-visible context on mismatch, `"deny"` blocks, `false` disables. Under `"deny"` only a passed, wrong `model` is blocked; an omitted one stays a warning. A deliberate escalation via `resolve-execution <agent> --attempt N` writes a single-slot `.gsd/model-escalation-<agent>.json` that the guard honours for 10 minutes for that model only and, when both sides know a session id, only in the session that ran `resolve-execution`; nothing clears it earlier. Fails open on any inability to verify, including a `.planning/config.json` larger than 64 KiB, so `"deny"` is not enforced then.

**Requirements:**
- REQ-SEC-01: All user-supplied file paths MUST be validated against the project directory
- REQ-SEC-02: Prompt injection patterns MUST be detected before text enters planning artifacts
- REQ-SEC-03: Security hooks MUST be advisory-only (never block legitimate operations)
- REQ-SEC-04: JSON parsing of user input MUST catch malformed data gracefully
- REQ-SEC-05: macOS `/var` → `/private/var` symlink resolution MUST be handled in path validation
