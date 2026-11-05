# How to tag a multi-repository milestone

**Goal:** Close a milestone that shipped across several independently versioned repositories, recording each repository's own release and creating a local annotated tag in the repositories that were released — without inventing a shared version.

**Prerequisites:** A project whose `.planning/config.json` lists the repositories under `planning.sub_repos` (see [Multi-repo workspaces](../../gsd-core/references/git-integration.md)), and a milestone ready for `/gsd-complete-milestone`.

A GSD milestone version names a unit of planned work in `.planning/`. It is not a release version: a GSD milestone version may differ from every repository release version, and the repositories need not share one sequence. This guide records what each repository actually released against the milestone.

---

## 1. Turn on per-repository tagging

```bash
gsd_run query config-set git.repo_tagging per_repo
```

`git.repo_tagging` is `single` by default, which keeps the existing behavior: one `v[X.Y]` tag in the current directory. With `per_repo` and a non-empty `sub_repos` list, `/gsd-complete-milestone` collects a release map instead and creates no shared tag. `per_repo` with an empty `sub_repos` list behaves like `single`.

`git.create_tag` still applies. With `git.create_tag: false` the release map is recorded and no tag is created.

## 2. Complete the milestone

Run `/gsd-complete-milestone`. When it reaches archival it asks, for each configured repository:

| Question | Meaning |
|---|---|
| Status | `released`, `deployed` or `unreleased` |
| Release | The repository's own version. It becomes the tag name, so it must start with a letter or digit and use only letters, digits, `.`, `_`, `+` and `-` (at most 200 characters). Leave it empty for an `unreleased` repository, which defaults to `skip` |
| Reference | A commit SHA or pull request reference. A hex SHA of 7 to 40 characters (case is ignored) is also the commit the tag is placed on; any other text (for example `PR #412`) is only recorded and the tag is placed on the repository's current `HEAD` |
| Environment | Free text such as `production`, `npm` or `development` |
| Tag | `create` a local annotated tag, or `skip` |

## 3. Review the consolidated confirmation

Before anything is written GSD checks every requested tag (the repository exists and is listed in `sub_repos`, the commit resolves, the tag is a valid name, and the tag does not already exist at a different commit), checks that the release map itself is valid, and shows one table that includes the commit each tag will be placed on:

```text
Repository  Release     Reference   Environment  Tag     Commit
dashboard   v5.78.0     PR #412     production   create  HEAD (a1b2c3d)
composers   unreleased  abc1234     development  skip    —
```

If any check fails nothing is written, and the failing repository and reason are listed so you can correct the entry. Tags are placed on commits that already exist, so merge a repository's release branch first if the tag must sit on the merged commit.

## 4. Tags and the archive

After you confirm, the tags are created, each in its own repository whatever directory you started from. The archived release map records one tag state per repository:

| Tag state | Meaning |
|---|---|
| `created` | The tag was created now |
| `already_tagged` | The tag already existed at the requested commit (a retry) |
| `skipped` | You chose to skip tagging; the repository stays in the map |
| `none` | No tag was requested (tagging is disabled with `git.create_tag: false`) |

The map is stored in `.planning/milestones/<version>-RELEASE-MAP.json` and as a **Release mapping** table in the `MILESTONES.md` entry. It is archived by value, so a repository that later leaves `sub_repos` stays in the history exactly as recorded.

## 5. Decide what to push

Nothing is pushed by default. For each repository with a `created` or `already_tagged` tag GSD uses the `origin` remote (or asks which remote when there are several and none is `origin`) and asks a separate question that names the repository, the tag, the remote and the URL the push would go to, with any credentials removed from the URL:

```text
Push tag v5.78.0 from dashboard to remote origin (git@example.com:acme/dashboard.git)? (y/n)
```

Answer `n` (or leave a repository without a remote) and that repository's tag stays local. A push never covers branches or several tags at once.

---

## When something goes wrong

| Symptom | Cause | What to do |
|---|---|---|
| Preflight lists `tag_conflict` | The tag exists at a different commit (including a retry after the repository's `HEAD` moved, when you gave no commit SHA) | Pick another release name or give the commit SHA; the existing tag is never overwritten |
| Preflight lists `repo_not_configured` or `repo_path_invalid` | The repository is not in `sub_repos`, or the path escapes the project | Correct the entry or `sub_repos` |
| Preflight lists `ref_unresolved` | The reference you gave as a commit does not exist in that repository | Fix the SHA, or give non-hex text so the tag is placed on `HEAD` |
| Some tags were created and the command failed | A write failed after earlier ones succeeded | The failure report lists the `created` pairs. Run `/gsd-complete-milestone` again and enter the same answers: tags already created report `already_tagged` and only the failed ones are retried |

For the command contract see [CLI tools](../CLI-TOOLS.md) (`milestone release-tags`, `milestone complete --release-map`); for the settings see [Configuration](../CONFIGURATION.md#per-repository-release-mapping).
