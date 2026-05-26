# Org-level security baseline — open-gsd

## 1. Status & scope

| Field | Value |
|---|---|
| RFC status | Draft |
| Version | 0.1.0 |
| Last updated | 2026-05-22 |
| Owner | @open-gsd/maintainers (`@trek-e @Solvely-Colin @jeremymcs`) |

### Repos in scope

All active, non-archived repositories under the `open-gsd` GitHub organization,
beginning with the pilot repo `open-gsd/get-shit-done-redux`.

### Out of scope

- Forks of `open-gsd` repos owned by third parties
- Archived repositories (read-only, no CI)
- Personal repos that happen to be used during development

---

## 2. Minimum security controls

This section defines the mandatory security controls for every in-scope repo.
Each control links to the PR that implements it in the pilot repo
(`open-gsd/get-shit-done-redux`). Sibling repos adopt the same controls during
Phase 2 rollout (§ 6).

### 2.1 Dependency integrity

**Control:** All third-party dependencies must be pinned via a lock file
(`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`) and verified against
published checksums before install. Supply-chain attacks (e.g., dependency
confusion, typosquatting) are mitigated by ensuring that what CI installs
matches what maintainers reviewed.

**Why it matters:** The NIST SSDF (PW.4, PS.3) explicitly requires that
components be verified for integrity before use.
([SSDF v1.1](https://csrc.nist.gov/publications/detail/sp/800-218/final))
The SLSA framework's "Provenance" requirements (L2+) depend on lock-file
integrity as a prerequisite.
([SLSA](https://slsa.dev/))

**Implementation in pilot:** PR
[#135](https://github.com/open-gsd/get-shit-done-redux/pull/135)
(linked to issue
[#114](https://github.com/open-gsd/get-shit-done-redux/issues/114)).

**Verify locally:**

```bash
npm ci --prefer-offline   # fails if lock file is out of sync
npm audit --audit-level=high
```

**How it fails in CI:** The `npm ci` step exits non-zero if `package-lock.json`
is missing or inconsistent with `package.json`. A separate `npm audit` step
fails the build on `high` or `critical` severity advisories.

---

### 2.2 Secret scanning

**Control:** Every commit and PR is scanned for hardcoded secrets (API keys,
tokens, credentials) before merge. Intentional test fixtures and false positives
must be annotated with the project-standard exclusion grammar; un-annotated
suppressions are not permitted.

**Why it matters:** Exposed credentials are the leading cause of cloud-account
compromise. GitHub's own research cites thousands of new credentials committed
to public repos daily. ISO/IEC 29147 (§ 6.3) lists credential exposure as a
critical disclosure category.
([ISO/IEC 29147](https://www.iso.org/standard/72311.html))
GitGuardian's annotation grammar provides an auditable, reviewable exclusion
mechanism.
([GitGuardian exclusion grammar](https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets))

**Implementation in pilot:** PR
[#134](https://github.com/open-gsd/get-shit-done-redux/pull/134)
(linked to issue
[#115](https://github.com/open-gsd/get-shit-done-redux/issues/115)).
Exclusion annotation files: `.secretscanignore` (top-level) and
`.base64scanignore` (top-level, for base64-encoded values).

**Verify locally:**

```bash
# If ggshield is installed:
ggshield secret scan pre-commit
# Otherwise, inspect .secretscanignore to confirm all entries are annotated
grep -n "# ggignore" .secretscanignore
```

**How it fails in CI:** The pre-commit / CI hook runs the secret scanner; any
un-annotated hit causes the job to exit non-zero.

---

### 2.3 Prompt-injection scanning

**Control:** Prompt-injection patterns in user-supplied content or agent
instructions are detected and flagged before execution. This applies to any
workflow that passes user-controlled text to an LLM or AI agent.

**Why it matters:** The OWASP SAMM Threat Assessment practice (TA2) requires
identifying and mitigating injection attack surfaces. Prompt injection is an
emerging supply-chain vector specific to AI-assisted workflows.
([OWASP SAMM](https://owaspsamm.org/))
The CNCF Security TAG's supply-chain security guidance addresses injection
risks in automated pipelines.
([CNCF Security TAG](https://github.com/cncf/tag-security))

**Implementation in pilot:** PR
[#133](https://github.com/open-gsd/get-shit-done-redux/pull/133)
(linked to issue
[#113](https://github.com/open-gsd/get-shit-done-redux/issues/113)).

**Verify locally:**

```bash
# Run the injection scanner (command defined in the implementing PR)
npm run scan:prompt-injection
```

**How it fails in CI:** The scan step exits non-zero on any detected injection
pattern. Verified false positives must be annotated in the project's exclusion
file before the job passes.

---

### 2.4 Locale-safe text scanning

**Control:** Text output and user-facing strings are scanned for locale-unsafe
constructs (non-ASCII homoglyphs, bidirectional override characters, invisible
Unicode) that could be used to obscure malicious content in diffs or logs.

**Why it matters:** Unicode homoglyph and BiDi attacks are documented
supply-chain vectors (CVE-2021-42574 — "Trojan Source"). Detecting them at scan
time prevents invisible payload injection in source and output files.

**Implementation in pilot:** PR
[#132](https://github.com/open-gsd/get-shit-done-redux/pull/132)
(linked to issue
[#116](https://github.com/open-gsd/get-shit-done-redux/issues/116)).

**Verify locally:**

```bash
# Run the locale-safety scanner (command defined in the implementing PR)
npm run scan:locale
```

**How it fails in CI:** Any detected unsafe Unicode construct causes the scan job
to exit non-zero.

---

### 2.5 Reproducible env bootstrap

**Control:** The development and CI environment must be bootstrapped
reproducibly: the same inputs always produce the same installed-dependency set.
This requires a committed lock file, a pinned Node.js version (`.nvmrc` or
`engines` field in `package.json`), and a CI install step that refuses to
update the lock file silently.

**Why it matters:** NIST SSDF PO.5 (Implement and Maintain Secure Environments
for Software Development) requires that build environments be defined and
controlled.
([SSDF v1.1](https://csrc.nist.gov/publications/detail/sp/800-218/final))
OpenSSF Scorecard's "Pinned-Dependencies" check measures this directly.
([OpenSSF Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md))

**Implementation in pilot:** PR for issue
[#117](https://github.com/open-gsd/get-shit-done-redux/issues/117)
(see PR #136).

**Verify locally:**

```bash
node --version   # must match .nvmrc / engines field
npm ci           # must succeed without modifying lock file
```

**How it fails in CI:** `npm ci` exits non-zero if `package-lock.json` would be
modified. A Node version mismatch against `.nvmrc` triggers an explicit error in
the `setup-node` action step.

---

### 2.6 Release checks

**Control:** Every published release is gated by the existing release workflow
(`.github/workflows/`). This workflow enforces:

- All CI checks pass on the release branch
- The version bump is consistent with the semver policy (`VERSIONING.md`)
- The changelog entry is present (`CHANGELOG.md`)
- The npm publish step uses a scoped token with minimal permissions

**Why it matters:** The SLSA framework's "Build" requirements (L1+) require that
releases are built by a controlled, auditable process — not by ad-hoc local
publishes.
([SLSA](https://slsa.dev/))
OpenSSF Best Practices Badge requires that the project use a consistent,
automated release process.
([OpenSSF Best Practices Badge](https://www.bestpractices.dev/en/criteria))

**Verify locally:**

```bash
# Dry-run the release workflow locally (if act is installed)
act --dryrun -W .github/workflows/release.yml
```

**How it fails in CI:** Any failing status check blocks the release branch merge.
The npm publish step uses `NPM_TOKEN` from GitHub secrets; a missing or expired
token causes publish to fail with a non-zero exit code.

---

## 3. Incident-audit checklist

Each incident type follows the NIST SP 800-61 Rev. 2 four-phase lifecycle:
Preparation → Detection & Analysis → Containment / Eradication / Recovery →
Post-Incident Activity.
([NIST SP 800-61 Rev. 2](https://csrc.nist.gov/publications/detail/sp/800-61/rev-2/final))

### 3.1 Secret-exposure incident

| Phase | Action |
|---|---|
| Detection | Alert from secret scanner CI step, or external reporter via a private GitHub security advisory |
| Containment | Immediately revoke the exposed credential in the issuing service (GitHub, npm, cloud, etc.) |
| Containment | Force-push or rewrite history to remove the secret from Git history (if public) |
| Containment | Rotate all credentials that shared the same scope as the exposed one |
| Eradication | Add the pattern to `.secretscanignore` with annotation, or fix the source to not commit it |
| Recovery | Re-issue new credentials; update CI secrets; confirm scanner passes on new credential set |
| Lessons learned | File a post-mortem issue; update pre-commit hooks if scanner failed to catch it pre-commit |

### 3.2 Dependency-tampering incident

| Phase | Action |
|---|---|
| Detection | `npm audit` advisory, GHSA alert, or external reporter |
| Containment | Pin the affected package to a known-good version or remove the dependency |
| Containment | Rebuild and redeploy any artifacts produced while the tampered version was in use |
| Eradication | Update `package-lock.json`; run `npm audit` to confirm 0 high/critical advisories |
| Recovery | Re-run full test suite; publish a patch release if the package is distributed |
| Lessons learned | File a post-mortem issue; consider adding the package to a dependency-allowlist if applicable |

### 3.3 Prompt-injection incident

| Phase | Action |
|---|---|
| Detection | Unexpected LLM output, CI scan hit, or user report of anomalous agent behavior |
| Containment | Disable or gate the affected workflow; quarantine the user-supplied input |
| Containment | Audit LLM call logs for the affected timeframe to bound the blast radius |
| Eradication | Sanitize or reject the injection vector; update scanner rules to cover the new pattern |
| Recovery | Re-enable workflow after scanner update passes; verify with a replay of the triggering input |
| Lessons learned | File a post-mortem issue; update scanner pattern library; review trust boundaries in LLM workflows |

### 3.4 Hook-bypass incident

| Phase | Action |
|---|---|
| Detection | PR merged without expected CI status; commit without hook output; direct-push alert |
| Containment | Revert the bypassed merge/push if the content is unsafe |
| Containment | Audit who bypassed the hook and how (force-push, `--no-verify`, branch-protection exception) |
| Eradication | Restore branch protection rules; remove any temporary bypass grants |
| Recovery | Re-run scans on the bypassed content; re-merge after hooks pass |
| Lessons learned | File a post-mortem issue; add a required status check for the bypassed hook if not already present |

---

## 4. Reporting format

### Where to report

Report security vulnerabilities via **private security advisory** on GitHub:
`https://github.com/open-gsd/get-shit-done-redux/security/advisories/new`

Do not open public issues for security vulnerabilities.

If private advisory filing is unavailable, contact the open-gsd maintainers and include a link to this policy.

**Source:** [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories)

---

### What to include (CVE-style template)

```text
Title:         [Short description, e.g., "Secret exposed in CI log for PR #NNN"]
Affected repo: open-gsd/get-shit-done-redux (or sibling repo name)
Affected ver:  [npm version range, e.g., "<=1.42.3" or "all versions"]
Reporter:      [Your name / handle, or "Anonymous"]
Date found:    YYYY-MM-DD

Description:
  [One paragraph: what the vulnerability is, where it lives, how it was found]

Reproduction steps:
  1. ...
  2. ...

Impact:
  [What an attacker could do if they exploited this]

Suggested fix (optional):
  [If you have a patch or mitigation idea]

CVSS score (optional):
  [CVSS v3.1 base score and vector string if known]
```

---

### Severity rubric (CVSS-aligned)

| Severity | CVSS v3.1 range | Response target |
|---|---|---|
| Critical | 9.0 – 10.0 | Acknowledge within 24 h; fix ASAP |
| High | 7.0 – 8.9 | Acknowledge within 48 h; fix ≤1 wk |
| Medium | 4.0 – 6.9 | Acknowledge within 1 wk; next minor |
| Low | 0.1 – 3.9 | Acknowledge within 2 wk; next minor |

---

### Disclosure timeline

This project follows **coordinated disclosure** aligned with ISO/IEC 29147:

1. Reporter submits via private advisory or email.
2. Maintainer acknowledges within the window above.
3. Maintainer provides an estimated fix date.
4. Fix is developed in a private fork / branch.
5. Fix is released; advisory is published simultaneously (or reporter is
   credited in release notes, at their option).
6. If no fix is delivered within 90 days of acknowledgment, the reporter may
   disclose publicly.

**Source:** [ISO/IEC 29147](https://www.iso.org/standard/72311.html)

---

## 5. Ownership model

### Scanner policy owner

**Owner:** `@open-gsd/maintainers` (`@trek-e @Solvely-Colin @jeremymcs`), as
reflected in `.github/CODEOWNERS`.

Responsibilities:

- Approve changes to scanner configuration files (`.secretscanignore`,
  `.base64scanignore`, and any prompt-injection / locale-scan config)
- Review and merge scanner-rule updates
- Triage false-positive exclusion requests

### Exclusion governance

**Owner:** `@open-gsd/maintainers`

- All exclusions must use the annotation grammar defined in the implementing
  PRs (§ 2.2 for secret scanning; equivalent for other scanners)
- Un-annotated suppression comments are a policy violation; CI enforces this
- Exclusions are reviewed at each quarterly review (see below)

### Baseline owner (this document)

**Owner:** `@open-gsd/maintainers`

- Quarterly review cadence (calendar entry required — see § 8 checklist)
- Any substantive change to this document requires a PR reviewed by at least
  one maintainer
- The RFC status field (§ 1) must be updated from `Draft` → `Approved` after
  first maintainer review, and `Approved` → `Adopted` after Phase 1 completion

### Exception / waiver process

| Step | Detail |
|---|---|
| 1 | Requester opens a GitHub issue in `open-gsd/get-shit-done-redux` tagged `security-exception` |
| 2 | Issue describes: which control, why the exception is needed, proposed compensating control |
| 3 | One maintainer approves the exception in the issue thread |
| 4 | Exception is time-limited: maximum 90 days. Requester must file a renewal or close the issue. |
| 5 | All active exceptions are audited at each quarterly review |

---

## 6. Rollout plan

### Phase 1 — Pilot: `open-gsd/get-shit-done-redux` (in progress)

| Item | Status | Owner | Target date | Exit criteria |
|---|---|---|---|---|
| Locale-safe text scanning (#116) | In progress | `@open-gsd/maintainers` | TBD: maintainer | PR #132 merged; CI passes |
| Prompt-injection scanning (#113) | In progress | `@open-gsd/maintainers` | TBD: maintainer | PR #133 merged; CI passes |
| Secret scanning (#115) | In progress | `@open-gsd/maintainers` | TBD: maintainer | PR #134 merged; CI passes; 0 un-annotated entries |
| Dependency integrity (#114) | In progress | `@open-gsd/maintainers` | TBD: maintainer | PR #135 merged; `npm audit` clean |
| Reproducible env bootstrap (#117) | In progress | `@open-gsd/maintainers` | TBD: maintainer | PR #136 merged; `npm ci` passes cleanly |
| Baseline doc approved | Draft | `@open-gsd/maintainers` | TBD: maintainer | At least one maintainer approves this document |

### Phase 2 — Sibling repo alignment

Sibling repos under `open-gsd` that must adopt the same controls:

> **TBD — maintainer to enumerate.** The complete list of active, non-archived
> sibling repos is not enumerable from this branch without org-level API access.
> A maintainer must populate this list before Phase 2 begins.

Per sibling repo, the expected work is:

1. Copy scanner configuration files from the pilot repo
2. Enable the same CI workflow steps
3. Run an initial baseline scan; triage and annotate all existing false positives
4. Open a rollout PR referencing this baseline document
5. Update the Phase 2 table above once the PR merges

**Target date:** TBD: maintainer
**Owner:** `@open-gsd/maintainers`

### Phase 3 — Enforcement

Once all in-scope repos have adopted all controls:

1. Upgrade any warning-level scanner steps to hard failures (non-zero exit)
2. Enable branch protection rules that require all security CI checks to pass
3. Update the OpenSSF Scorecard configuration (if applicable) to measure adoption
4. Mark RFC status as `Adopted` in § 1

**Target date:** TBD: maintainer
**Owner:** `@open-gsd/maintainers`

---

## 7. KPIs / health checks

These metrics measure adoption and detect drift. The primary measurement source
for adoption-style KPIs is the
[OpenSSF Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md).

| KPI | Target | Measurement source | Review cadence |
|---|---|---|---|
| Per-repo baseline controls active | 100% (all 6) | CI status checks per repo | Quarterly |
| Mean time to remediate dependency drift | TBD: maintainer | Time between `npm audit` alert and fix PR merge | Quarterly |
| Grandfathered (un-annotated) scanner exclusions | 0 | Automated scan of exclusion files in CI | Quarterly |
| Quarterly review held (minutes linked) | 1 per quarter | GitHub issue or meeting notes linked in § 8 | Quarterly |
| Open security exceptions past 90-day limit | 0 | Manual audit of `security-exception` issues | Quarterly |
| Phase 2 sibling repos fully adopted | 100% of in-scope | Per-repo rollout PR merged + CI green | Per rollout |

**Note on mean-time-to-remediate target:** OpenSSF Scorecard does not prescribe
a specific number of days for this metric. The maintainer should set a target
based on historical data after the first quarterly review.

---

## 8. Follow-up tracking checklist

- [ ] Maintainer review of this baseline (required before RFC status → `Approved`)
- [ ] Sibling repo enumeration (populate Phase 2 table in § 6)
- [ ] CODEOWNERS update to explicitly list `docs/security/` as owned by
      `@open-gsd/maintainers`
- [ ] Quarterly review calendar entry created (link to be added here)
- [ ] Per-control adoption tracking issue opened for each Phase 2 sibling repo
- [ ] Phase 2 rollout PR(s) opened per sibling repo (one PR per repo)
- [x] PR #136 for issue #117 (reproducible env bootstrap) opened and linked in § 2.5
- [ ] RFC status field (§ 1) updated to `Approved` after maintainer review
- [ ] RFC status field (§ 1) updated to `Adopted` after Phase 3 completion
- [ ] OpenSSF Scorecard integration evaluated for org-level adoption tracking

---

## 9. References

All primary sources cited in this document:

1. NIST SP 800-218 SSDF v1.1 (Secure Software Development Framework):
   <https://csrc.nist.gov/publications/detail/sp/800-218/final>

2. NIST SP 800-61 Rev. 2 (Computer Security Incident Handling Guide):
   <https://csrc.nist.gov/publications/detail/sp/800-61/rev-2/final>

3. OpenSSF Scorecard checks:
   <https://github.com/ossf/scorecard/blob/main/docs/checks.md>

4. OpenSSF Best Practices Badge criteria:
   <https://www.bestpractices.dev/en/criteria>

5. OWASP SAMM (Software Assurance Maturity Model):
   <https://owaspsamm.org/>

6. CNCF Security TAG:
   <https://github.com/cncf/tag-security>

7. GitHub Security Advisories documentation:
   <https://docs.github.com/en/code-security/security-advisories>

8. ISO/IEC 29147 — Vulnerability disclosure:
   <https://www.iso.org/standard/72311.html>

9. SLSA framework:
   <https://slsa.dev/>

10. GitGuardian exclusion grammar (secrets):
    <https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets>

11. RFC 9700 — OAuth 2.0 Security Best Current Practice:
    <https://www.rfc-editor.org/rfc/rfc9700>
