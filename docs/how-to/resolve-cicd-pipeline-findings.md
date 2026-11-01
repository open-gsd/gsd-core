# Resolve CI/CD pipeline findings

`/gsd-code-review` applies a reliability rubric to pipeline files: `.github/workflows/*.yml`, `Dockerfile*`, `docker-compose*.yml` and deploy scripts. This guide covers getting those findings and acting on them. For the rubric itself, see `gsd-core/references/cicd-review-patterns.md`.

## Get the findings

1. Make sure the pipeline files are in the review's scope. They are when the phase changed them, or when you pass them explicitly with `--files`.
2. Pick the depth.
   - `quick` runs three mechanical checks on GitHub Actions workflows only: unpinned actions, non-idempotent `npm install`, and jobs with no job-level `timeout-minutes`.
   - `standard` (the default) and `deep` run all eight checks on every pipeline file, including Dockerfiles, compose files and deploy scripts.
3. Run `/gsd-code-review <phase>` (add `--depth=quick` for the mechanical pass only).
4. Open `REVIEW.md` in the phase directory. Pipeline findings are ordinary `WR-` findings under `## Warnings`. A hardcoded secret in a pipeline file is still a `CR-` finding.

To raise depth only for your pipeline directories, use a path-scoped override (see [Scope code review depth by path](scope-code-review-depth-by-path.md)), for example `{ "paths": [".github/workflows"], "depth": "standard" }`.

## Fix each kind

| Finding | Usual fix |
|---|---|
| Unpinned action (`@main`, `@master`, `@latest`) | Pin to a release tag or, stronger, a full commit SHA |
| Non-idempotent install | `npm ci` instead of `npm install` when `package-lock.json` is committed; `mkdir -p`; guard `rm` |
| No job-level timeout | Add `timeout-minutes:` to the job, sized to its normal run plus margin |
| No concurrency guard on a deploy workflow | Add `concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: true }` |
| Per-environment rebuild | Build once, upload the artifact, and promote that same artifact to each environment |
| Deploy without health check or rollback | Add a post-deploy health check step and a rollback step that runs on its failure |
| Load-bearing `continue-on-error` | Remove it, or move the step after everything that depends on it |
| Static cloud credentials | Switch to the provider's OIDC login with `permissions: id-token: write` |

`/gsd-code-review --fix` treats these like any other Warning, so the fixer can apply them.

## When a finding looks wrong

These are not findings. Close them with a note, rather than changing the pipeline:

- `npm install -g <tool>`, or `npm install` in a repository with no `package-lock.json`.
- A job that calls a reusable workflow (`uses:` at the job level). It cannot set `timeout-minutes`.
- An action pinned to `@v4` or a SHA, a local `./action`, or a `docker://` reference.
- A missing `cancel-in-progress` on a workflow that only runs tests.
- `continue-on-error` on a step nothing depends on, such as a coverage upload.
- A secret for a provider that does not support OIDC.

## When you expected a finding and got none

| What you see | Why |
|---|---|
| `quick` reported nothing for a Dockerfile or deploy script | `quick` checks GitHub Actions workflows only. Run `standard`. |
| `quick` missed an unbounded job written in flow style (`jobs: { build: { … } }`) | The quick timeout check reads block-style YAML. `standard` reads the file. |
| `quick` missed `npm install` | It is skipped on comment lines and global installs, and only runs when `package-lock.json` exists in the directory the review runs from (the project root). A lockfile in a monorepo subdirectory is not seen; run `standard`. |
| The Summary says the CI/CD reference could not be read | The installation is missing `gsd-core/references/cicd-review-patterns.md`. The reviewer still applied the eight checks from its own rubric; reinstall to restore the full rubric. |
| No pipeline file in REVIEW.md's file list | The file was not in scope. Pass it with `--files`. |
