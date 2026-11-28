---
id: 3897
title: Runtime Marker Resolution, Derived Codex Sandbox, and In-Phase Short-Form Dependencies
group: v1.7.0 Features
---

**Purpose:** ADR-3473 §8.3: one implementation per invariant, not a hand-maintained copy
that drifts. This closes three instances across `gsd-tools`. The reasoning is in
[Why failures are surfaced, not absorbed](../explanation/why-failures-are-surfaced-not-absorbed.md#why-the-runtime-marker-the-derived-codex-sandbox-and-short-form-dependencies-3897).

**Behavior:**
- `resolveRuntime` ladder is now `GSD_RUNTIME` → `config.runtime` → the install-time
  `.gsd-runtime` marker → `'claude'`. The marker is normalized through the same routine as
  the env rung.
- `generateCodexAgentToml` derives `sandbox_mode` from each role's `tools:` frontmatter
  (`workspace-write` when it declares `Write` or `Edit`, `read-only` otherwise); the
  `CODEX_AGENT_SANDBOX` map is deleted. An explicit, self-invalidating hold list keeps the
  16 roles that would derive broader at `read-only`. All 35 emitted `.toml` files are
  byte-identical to before.
- `validate agents` reports `sandbox_posture` (report-only, exit 0, populated only when the
  active runtime is `codex`) for any installed Codex `.toml` whose `sandbox_mode` disagrees
  with its derivation.
- `depends_on` accepts the bare plan number (`"01"`), same phase only. A phase that used the
  bare form and had collapsed into one wave now executes in its declared waves. Two plans
  sharing a bare form resolve first-write-wins by sorted plan-file order.

**Known limits:**
- The held Codex roles stay at `read-only` until Codex's enforcement of `sandbox_mode` is
  confirmed.
- The bare plan-number form is ambiguous by construction when two plans in a phase share a
  short form; prefer the full or canonical id then.
- The install marker never feeds model-tier resolution, which reads `config.runtime` alone.
