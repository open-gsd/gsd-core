# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: **security@gsd.build** (or DM @glittercowboy on Discord/Twitter if email bounces)

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity, but we aim for:
  - Critical: 24-48 hours
  - High: 1 week
  - Medium/Low: Next release

## Scope

Security issues in the GSD codebase that could:
- Execute arbitrary code on user machines
- Expose sensitive data (API keys, credentials)
- Compromise the integrity of generated plans/code

## Recognition

We appreciate responsible disclosure and will credit reporters in release notes (unless you prefer to remain anonymous).

## Org-level security baseline

This file covers how to report individual vulnerabilities. For the broader
org-wide security posture — scanner controls, incident-audit checklists,
ownership model, and rollout plan — see:

[`docs/security/baseline.md`](docs/security/baseline.md)

## Secret-Scan Exclusion Governance

Secret-scanning exclusions (`.secretscanignore`) require structured annotations. Bare paths are accepted in default mode with a deprecation warning but are rejected in strict mode. The lint runs on every PR.

### Annotation format

```
# allow: <pattern>  reason="..."  owner="..."  expires="YYYY-MM-DD"  [rule-id="..."]
<pattern>
```

Required keys: `reason`, `owner`, `expires`. Wildcard patterns (`**`, `*.ext`) also require `rule-id`.

Lint locally: `scripts/secret-scan-lint.sh --file .secretscanignore`

### Periodic reduced-exclusion scan (release and security-review lanes)

Run this during every release and scheduled security review:

```bash
scripts/secret-scan.sh --diff origin/main --strict
```

The `--strict` flag:
- Does **not** honour grandfathered (un-annotated) exclusions — those files are scanned.
- Skips any exclusion whose `expires` date is in the past — those files are scanned.
- Is intended to surface accumulated exclusion debt that default mode masks.

If `--strict` finds findings that default mode does not, those findings represent either (a) an entry that should have been annotated and renewed, or (b) an actual secret that was only hidden by a stale exclusion. In both cases: investigate, remediate, and update the exclusion annotation.

References:
- GitGuardian exclusion annotation convention: https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets
- CNCF Security TAG threat-model exception lifecycle: https://github.com/cncf/tag-security/blob/main/community/working-groups/threat-modeling/templates/threats.md
