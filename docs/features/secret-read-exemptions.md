---
id: 4432
title: Project Exemptions for the Secret-Read Guard
group: v1.7.0 Features
---

**Hook:** `gsd-secret-read-guard.js` (PreToolUse — Read, Grep, Bash)

**Purpose:** Let a project name specific committed files that the secret-read guard should not block, such as a placeholder template whose name (`.env.production`) matches a protected pattern, without disarming the guard for every other `.env` file. Before this, the only lever was removing the hook's registration, which unprotected the whole tree and came back on every update.

**Requirements:**
- REQ-SECRET-EXEMPT-01: An unconfigured project MUST block exactly as before; the config is read only after a token has already been classified as a secret name.
- REQ-SECRET-EXEMPT-02: An exemption MUST apply only to a path listed in `hooks.secret_read_exempt` that is committed in `HEAD` as a regular file (mode `100644`/`100755`) and is a regular file in the working tree. An unreadable or unsupported repository (SHA-256, a missing object, a corrupt pack) or a missing `HEAD` MUST leave the file blocked. The check reads `.git` directly — no subprocess, no timer — so the verdict depends only on the repository's bytes.
- REQ-SECRET-EXEMPT-03: Read and Grep `path` MAY resolve a relative path against the session directory; Bash MUST honor an exemption only for an absolute path, because a relative shell word can name a different file after `cd`, in `find -name`, or through `xargs`.
- REQ-SECRET-EXEMPT-04: An exempt operand MUST NOT end the scan: another secret named in the same command is still refused.
- REQ-SECRET-EXEMPT-05: `config-set` and the guard MUST accept and reject the same entries (absolute, `..`, empty, non-string and directory-shaped entries refused; `\` read as `/`; leading `./` dropped).

**Why the committed-file rule:** agents routinely write `.planning/config.json`. If the list alone were enough, an agent steered by injected text could add `.env` to it and read real credentials. Real secret files are untracked and ignored; a committed file's contents are already in the repository's history, so exempting it exposes nothing the repository does not already hold.

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `hooks.secret_read_exempt` | array of strings | `[]` | Repo-relative paths of committed files the guard lets agents read. Exact paths only — no globs. See [CONFIGURATION.md](CONFIGURATION.md) and [the how-to](how-to/let-agents-read-a-committed-env-template.md). |

**Known limits:** a Grep `glob` is not widened (use `path`); Bash needs the absolute path; a file must be committed before its exemption applies; the guard vouches for the path, not for working-tree bytes that differ from `HEAD`; only the root project config is read.
