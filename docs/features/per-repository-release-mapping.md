---
id: 3628
title: Per-Repository Release Mapping
group: v1.7.0 Features
---

**Command:** `/gsd-complete-milestone`

**Config key:** `git.repo_tagging` (`single` default, `per_repo`)

**Purpose:** A milestone that ships across several independently versioned repositories cannot be described by one `v[X.Y]` tag. A GSD milestone version names planned work in `.planning/`; each repository has its own release version, and some repositories may not be released at all. This feature records what each repository actually released against the milestone ([ADR-3628](adr/3628-milestone-release-mapping.md), epic #3628).

**Behavior:** With `git.repo_tagging: per_repo` and a non-empty `planning.sub_repos`, milestone completion collects one release map entry per repository (status, release, reference, environment, tag choice), checks every requested tag before writing anything, shows one consolidated confirmation, creates the local annotated tags with `milestone release-tags`, and archives the map with `milestone complete --release-map`. No shared tag is created in the current directory on this path. Skipped and unreleased repositories stay in the archived map without receiving a tag.

**Push:** Nothing is pushed by default. Each repository's tag is a separate confirmation naming the repository, the tag, the remote and its URL; a decline or failed push affects that repository only.

**Compatibility:** `single` keeps the existing step unchanged, and `git.create_tag` keeps its meaning. With `per_repo`, `git.create_tag: false` still records the map and creates no tags. Archives without a map continue to parse.

**Requirements:**
- REQ-RELEASE-MAP-01: Tags MUST NOT be created before every requested tag has passed preflight.
- REQ-RELEASE-MAP-02: An existing tag at a different commit MUST NOT be overwritten.
- REQ-RELEASE-MAP-03: No tag MAY be pushed without a confirmation that names the repository and the remote.
- REQ-RELEASE-MAP-04: The archived map MUST be stored by recorded value, not derived from `planning.sub_repos` at read time.

**Reference:** [How to tag a multi-repository milestone](how-to/tag-a-multi-repo-milestone.md) · [Configuration Reference](CONFIGURATION.md#per-repository-release-mapping) · [CLI tools](CLI-TOOLS.md)
