<step name="release_map">

Per-repository release mapping (#3628, ADR-3628). Runs only when the init JSON has `repo_tagging` set to `per_repo` AND a non-empty `sub_repos` list. A GSD milestone version names planned work; each repository has its own release version, so no `v[X.Y]` tag is created in the current directory on this path.

This file is read twice: Part 1 from `archive_milestone`, Part 2 from `push_release_tags`.

Text mode: when `TEXT_MODE` is active, replace every `AskUserQuestion` with a numbered plain-text list.

Working directory for the two JSON files: `RELEASE_MAP_DIR="${TMPDIR:-/tmp}/gsd-release-map-v[X.Y]"`, created with `mkdir -p "$RELEASE_MAP_DIR"`; the map file is `"$RELEASE_MAP_DIR/release-map.json"`. Shell state does not persist between commands, so re-derive these paths in every command that uses them. Write both JSON files with the Write tool; never build them with `echo`, a heredoc or any shell interpolation of the answers.

## Part 1 — Collect, preflight, confirm, tag (runs inside `archive_milestone`, before `milestone complete`)

1. **Collect one entry per repository in `sub_repos`.** For each repository ask for:
   - `status`: `released`, `deployed`, or `unreleased`.
   - `release`: the repository's release version. When a tag is created it becomes the tag name, so it must match `^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$`; re-ask on a mismatch, never alter or skip it. Leave it empty for an `unreleased` repository and never invent one.
   - `reference`: a commit SHA or pull request reference (free text).
   - `environment`: free text, for example `production`, `npm`, `development`.
   - tag choice: `create` (create an annotated tag named `release`; requires a non-empty `release`) or `skip` (record the repository, create nothing). An `unreleased` repository defaults to `skip`.

   Every text field is limited to 200 characters and a map to 256 entries; re-ask when a value is longer. If `git_create_tag` from init is `false`, do not ask the tag choice: every entry is recorded with a `tag` of `none`, no `tags.json` is built, and steps 3, 5 and 6 are skipped (the tag verb and the tag-state update); step 4 asks "Record this release map?" instead. Part 2 does not run.

2. **Build `release-map.json`** (array of `{ "repo", "release", "reference", "environment", "status", "tag" }`) with provisional tag states: `created` for a `create` entry, `skipped` for a `skip` entry, `none` when tagging is disabled. When tags are requested, also build `tags.json` in the same directory: `{ "repo": "<repo>", "tag": "<release>", "ref": "<ref>" }` for each `create` entry and `{ "repo": "<repo>", "skip": true }` for each `skip` entry. `ref` is the entry's `reference`, lowercased, only when it matches `^[0-9a-f]{7,40}$`; any other reference text (for example `PR #412`) is recorded but the tag is placed on the repository's current `HEAD`.

3. **Validate everything before anything is written:**

   ```bash
   gsd_run query milestone release-tags --map "$RELEASE_MAP_DIR/tags.json" --dry-run
   gsd_run query milestone.complete "v[X.Y]" --dry-run --release-map "$RELEASE_MAP_DIR/release-map.json"
   ```

   If the first reports `ok: false`, show each error with its repository and `reason`; a `tag_conflict` means the tag already exists at a different commit and is never overwritten. If the second fails, it lists every release map problem. Let the user correct the entries or abort, and repeat. Do not continue while either check fails.

4. **One consolidated confirmation.** Show a single table and ask once (AskUserQuestion: "Create these tags? Nothing is pushed." — Create / Edit / Cancel). Include the commit each tag will be placed on (`commit`, shortened, from the dry-run result) and say so when the tag lands on the repository's current `HEAD` rather than a given SHA or when the result reports `detached_head`:

   ```text
   Milestone v[X.Y] — [Name]

   Repository  Release     Reference   Environment  Tag     Commit
   dashboard   v5.78.0     PR #412     production   create  HEAD (a1b2c3d)
   composers   unreleased  abc1234     development  skip    —
   ```

   On Cancel, stop: nothing has been written and `milestone complete` is not called.

5. **Create the tags:**

   ```bash
   gsd_run query milestone release-tags --map "$RELEASE_MAP_DIR/tags.json"
   ```

   If the command exits non-zero, report every repository's status and the `created` list (`repo:tag` pairs already written). Stop before `milestone complete`; running the same command again is safe, it retries only what failed and reports tags already written as `already_tagged`. Tags are placed on commits that already exist in each repository, so merge or squash a repository's release branch before running this flow if the tag must sit on the merged commit.

6. **Record the outcome in the map.** Rewrite `release-map.json` so each `create` entry's `tag` is that repository's `status` from the result (`created` or `already_tagged`); leave `skipped` and `none` as they are. Valid `status` values are `released`, `deployed`, `unreleased`; valid `tag` values are `created`, `already_tagged`, `skipped`, `none`.

7. **Archive the map with the milestone** by adding `--release-map "$RELEASE_MAP_DIR/release-map.json"` to every `milestone complete` call in `archive_milestone`. The map is stored as recorded, whether or not any tag was created.

## Part 2 — Push confirmation (runs after the archive, in place of the single-repository push prompt)

Nothing is pushed by default. For each repository whose entry has `tag` of `created` or `already_tagged`, one at a time. Take `REPO`, `REMOTE` and `TAG` only from the validated release map and the repository's own `git remote` list, and write them into the commands below as single-quoted literals.

Choose the remote: `origin` when `git -C "$REPO" remote` lists it; when there are several remotes and none is `origin`, show the list and ask which one; when there is none, report that and move on. Then show where the push would go (the push URL, with any embedded credentials removed before it is shown):

```bash
git -C "$REPO" remote get-url --push "$REMOTE"
```

Ask a separate question naming the repository, the tag, the remote and that URL:

`Push tag <tag> from <repo> to remote <remote> (<url>)? (y/n)`

Only on `y`, push that one tag, with `GIT_TERMINAL_PROMPT=0` exported:

```bash
git -C "$REPO" push -- "$REMOTE" "refs/tags/$TAG"
```

A decline, a failed push, or a push that does not finish is reported for that repository only; continue with the next repository. Never push branches, never push several tags in one command, and never push without the answer for that repository.

</step>
