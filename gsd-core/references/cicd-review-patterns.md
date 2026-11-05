# CI/CD Pipeline Review Patterns

Rubric for the **CI/CD pipelines** entry of `gsd-code-reviewer`'s language-aware checks. Read at `standard` and `deep` depth only, when a file in scope is a pipeline file. These defects rarely fail a test. They show up at release or deploy time, as a broken release or a bad production deploy.

Pipeline files are recognized by path, not extension: `.github/workflows/*.yml` / `*.yaml`, `Dockerfile*` / `Containerfile`, `docker-compose*.yml` / `compose*.yaml`, and deploy scripts (`deploy*.sh` and equivalents). A deploy script is also a Shell file: apply both sets of checks.

Adapted from the `ci-cd-reliability-architecture` skill in [l-gevity/l-gevity-skills](https://github.com/l-gevity/l-gevity-skills) (MIT), reduced to what is checkable from file contents at review time (#4101).

## Checks

| Check | Signal | Why it matters | Severity |
|---|---|---|---|
| **Non-idempotent step** | `npm install` where a `package-lock.json` exists (should be `npm ci`); `pip install` with no lock or pinned requirements; `mkdir` without `-p`; an unguarded `rm`; delete-then-create of a live resource | A re-run produces a different result, or fails part-way and leaves the target broken | Warning |
| **Missing timeout** | A job with `runs-on:` and no job-level `timeout-minutes:` | A stuck job holds its runner until the 6-hour default | Warning |
| **Missing concurrency guard** | A deploy workflow with no `concurrency` group and `cancel-in-progress: true` | Two pushes run in parallel; the older run can finish last and deploy over the newer one | Warning |
| **Per-environment rebuild** | The same commit is built separately for each environment instead of build-once/promote | The artifact that reaches production is not the artifact that passed CI | Warning |
| **Deploy without health check or rollback** | A deploy step with no post-deploy health check and no rollback path | A bad deploy stays live until a human notices | Warning |
| **Load-bearing `continue-on-error`** | `continue-on-error: true` on a step whose success later steps assume | The failure is masked; later steps run on a broken state and the job reports green | Warning |
| **Static cloud credentials** | Long-lived cloud keys stored as secrets for a provider that supports OIDC (`permissions: id-token: write`) | A leaked key stays valid until someone rotates it; OIDC tokens expire per run | Warning |
| **Unpinned third-party action** | `uses: owner/action@main`, `@master` or `@latest` | An unpinned ref lets the action's code change between two runs of the same commit | Warning |

A hardcoded secret in a pipeline file stays Critical under the existing secrets rule. Style-level pipeline findings (step naming, step ordering, redundant checkout options) are Info.

## Evidence rule

Cite the line. For the concurrency, rebuild and rollback checks, also name what makes the workflow a deploy workflow (the trigger, the environment, the deploy command): those checks are about deploys, not every workflow.

## Negative space: NOT findings

- **Global tool installs.** `npm install -g <tool>` installs a tool, not the project's dependency tree. A repository with no `package-lock.json` has nothing for `npm ci` to read.
- **Reusable workflow calls.** A job that calls a reusable workflow (`uses:` at the job level) cannot set `timeout-minutes`; the called workflow owns its timeouts.
- **Pinned refs.** A version tag (`@v4`) or a full commit SHA is a pin. Local actions (`./path`) and `docker://` references are not third-party action refs.
- **CI-only workflows.** `cancel-in-progress` is required on deploy workflows. On a workflow that only runs tests it is an optimization, not a Warning.
- **Informational steps.** `continue-on-error` on a step nothing depends on (a coverage upload, a notification) masks nothing.
- **Providers without OIDC.** A secret for a provider that does not support OIDC is not a static-credential finding.

## Example

```markdown
### WR-02: Deploy workflow lacks concurrency guard — stale commit can deploy last

**File:** `.github/workflows/deploy.yml:8`
**Issue:** Two pushes in quick succession run in parallel; the older run can finish after the newer one and overwrite production.
**Fix:** Add a `concurrency` group keyed on the ref, with `cancel-in-progress: true`.
```
