# PRD-1244 — Capability Ecosystem

- **Status:** Proposed
- **Date:** 2026-06-14
- **Owner:** Tom Boucher (maintainer)
- **Tracking issue:** [#1244](https://github.com/open-gsd/gsd-core/issues/1244)
- **Architecture:** [ADR-1244](../adr/1244-capability-ecosystem.md)
- **Target release:** 1.6.0

> This PRD captures the *what* and *why*. The *how* lives in [ADR-1244](../adr/1244-capability-ecosystem.md). Where the two overlap, the ADR is authoritative on architecture and this PRD is authoritative on product intent, scope, and success.

---

## 1. Summary

GSD 1.6.0 opens the capability platform (ADR-857) to **third-party authors**. Developers can write a capability, publish it at a URL, and any GSD user can `import` it, keep it `up to date`, and `remove` it cleanly — with versioned manifests, host-compatibility checks, and an explicit trust gate for capabilities that run code. A generated **capability matrix** documents every capability (native and third-party) and gives authors a place to plug in.

## 2. Problem & opportunity

ADR-857 made GSD extensible *in principle* — 12 loop extension points, 32 capabilities — but the platform is closed: the registry is build-time-only, capabilities are unversioned, and there is no per-capability install/upgrade/remove. A solo developer cannot share the capability they built, and cannot adopt one someone else built, without forking GSD or routing a PR through the maintainer.

The opportunity: turn an internal architecture into an **ecosystem**, where the long tail of stack-specific and house-style capabilities lives *outside* the core repo — reducing maintainer burden while expanding what GSD can do for any given user.

## 3. Personas

| Persona | Goal | Today's pain |
|---|---|---|
| **Capability author** (solo dev who extends GSD) | Ship a reusable capability (a deploy gate, a house-style review step, a domain planner contribution) once and reuse it everywhere | No distribution path; must fork GSD or upstream a PR for every change |
| **Capability consumer** (solo dev using GSD) | Add a community/team capability to a project in one step, and keep it current | No install path; no version surface; no clean removal |
| **Maintainer** | Grow GSD's reach without absorbing every extension as permanent core maintenance | Every useful idea becomes an upstream PR and forever-maintenance |
| **Team lead / enterprise admin** | Constrain which capability sources are allowed | No allowlist; no trust controls |

## 4. Goals

- **G1.** A capability author can publish a capability at a Git URL (or npm/tarball/registry) and a consumer can install it with one command.
- **G2.** Capabilities are versioned; consumers can see when an update exists and apply it deliberately.
- **G3.** Host↔capability compatibility is explicit (`engines.gsd`) and enforced, with graceful downgrade where possible.
- **G4.** Installing a capability that runs code (hooks/MCP/command modules) requires informed, explicit consent and integrity verification — and never runs code at install time.
- **G5.** Capabilities can be upgraded atomically and removed cleanly (files + shared-config fragments), with no orphaned state.
- **G6.** A capability matrix documents every capability and gives third parties a documented way to be listed.

## 5. Success metrics

- **Adoption:** ≥1 documented end-to-end author→publish→consumer-install flow works on all tier-1 runtimes (Claude/Codex/Antigravity) at release; the four how-to guides are each independently completable by following only the docs.
- **Safety:** zero code execution during `install` (verified by test); every executable surface is disclosed before consent (verified by test); `strictKnownRegistries: []` blocks all external installs (verified by test).
- **Integrity:** an install with a mismatched `integrity`/SHA aborts (verified by test); auto-update with a changed executable set re-prompts (verified by test).
- **Cleanliness:** `remove` followed by a filesystem audit shows no residual capability files and no leftover entries in shared `settings.json`/`hooks.json` (verified by test).
- **Honesty of the matrix:** the generated matrix never drifts from the registry (drift guard in CI).

## 6. Scope (1.6.0)

**In scope:** versioned `capability.json`; runtime registry overlay; `gsd capability install|update|outdated|remove|disable|list`; source resolver (registry/git/npm/tarball/local); capability ledger; trust/integrity/consent gate; native version stamping; registry-driven dispatch for third-party command families; the generated capability matrix; the full diataxis documentation set.

**Out of scope (explicit non-goals for 1.6.0):**
- **Operating a hosted central community registry.** The *manifest* and *matrix mechanic* ship; whether GSD runs/advertises a curated registry is **TBD/TBA** (see §8). URL/git import does not depend on it.
- **Sandboxing third-party code.** Out of reach technically; the trust model is consent + integrity + reversibility (ADR-1244 D5).
- **Automated malware scanning / safety scorecards.** A possible follow-up if a curated registry is adopted; not in 1.6.0.
- **A capability marketplace UI.** Docs + CLI only.
- **Paid/licensed capabilities, telemetry, or usage analytics.**

## 7. Functional requirements (product-level)

- **FR1.** `install <spec>` accepts registry/git(#tag,#sha)/npm/tarball/local specs; shows a pre-install summary (name, version, author, artifact counts, **executable surfaces**, context-cost note) and requires consent for non-trusted sources.
- **FR2.** `engines.gsd` incompatibility blocks with a clear message and offers the newest `compatVersions`-compatible version when the source enumerates versions.
- **FR3.** `outdated` lists installed capabilities with an available update (per the documented per-source support matrix); `update [--all]` applies updates atomically.
- **FR4.** `remove <id>` deletes exactly what the ledger recorded (files + shared-config fragments) and prompts before deleting persistent capability data; `disable <id>` toggles off without removing files.
- **FR5.** `list` shows installed capabilities with version, source, tier, and enabled/disabled state.
- **FR6.** Reserved namespaces and `strictKnownRegistries` are enforced.
- **FR7.** Third-party capabilities, once installed, are indistinguishable from first-party in surface/config toggling and loop participation (subject to the load-time re-gate).

## 8. Open questions / decisions deferred

- **OQ1 — Advertise a community registry? (TBD/TBA).** The mechanic (versioned manifests + matrix + registry source adapter) ships. The product decision to *operate/advertise* a curated `gsd-capabilities-community` registry — with its review, scanning, and trust implications — is deferred to a follow-up. Recommendation when revisited: separate "official" (curated) from "community" (consented) sources, mirroring Claude Code's marketplace split.
- **OQ2 — Provenance enforcement.** SHOULD for first-party/curated now; whether to *require* provenance for any listed third-party capability is tied to OQ1.
- **OQ3 — Inter-capability dependency resolution depth.** 1.6.0 validates `requires` closure remains satisfiable on install/upgrade; full npm-style transitive version resolution is a candidate follow-up.

## 9. Risks

- **Supply-chain risk** is the headline risk (third-party code at full parity). Mitigated by ADR-1244 D5; accepted by the maintainer as the cost of full parity.
- **Doc-vs-reality drift** — docs describe behavior that ships in phased PRs; docs land *with* the implementing phase, not ahead of it.
- **Maintainer-burden inversion** — if a community registry is later advertised (OQ1), review/scanning load returns; keeping it consented-but-decentralized avoids this.

## 10. Release & rollout

Phased per ADR-1244 (manifest versioning → overlay → resolver+ledger → trust gate → dispatch → docs/matrix). Documentation ships with the implementing phase. The advertising decision (OQ1) is explicitly a separate, later call — 1.6.0 ships the capability to import from any URL and the documentation mechanic, not a GSD-run storefront.
