# Let agents read a committed env template

GSD's secret-read guard blocks every read of `.env`, `.env.<suffix>` and `.secrets`
by the Read, Grep and Bash tools. Names ending in `.example`, `.sample`,
`.template` or `.dist` are templates and stay readable. When your project's template
has a name the guard protects — a committed `.env.production` full of `CHANGE_ME`
placeholders, say — agents cannot read it to add a line for a new variable.

This guide exempts that one file and keeps every other secret file blocked.

## Before you start

- The file must be **committed** in git. The guard checks `HEAD`, not your working tree
  or the index: an untracked, staged-only or ignored file is never exempted. That is
  what keeps a real secret from being unlocked by an edit to the project config.
- The file must be a regular file. A symlink, committed or not, is never exempted.
- You need a GSD project (`.planning/config.json` at the repository root).
- This is a guardrail, not a sandbox. The guard vouches for the path, not for working-tree bytes that differ from `HEAD`, and an agent with Bash can rewrite local repository state (force-add and commit, `update-ref`) to make a file count as committed. A file inside a submodule cannot be exempted: the submodule's `.git` file is not followed.

## Steps

1. Commit the template if it is not committed yet:

   ```sh
   git add .env.production
   git commit -m "chore: track the production env template"
   ```

2. List it in the project config, as a path relative to the project root:

   ```sh
   gsd-tools config-set hooks.secret_read_exempt '[".env.production"]'
   ```

   Several files go in one list: `'[".env.production", "deploy/.env.staging"]'`.
   `config-set` refuses a plain string, an absolute path, a path containing `..`, or an
   empty entry.

3. Check it: ask the agent to read the file with the Read tool. The read goes through.
   A read of any other `.env` file is still refused.

## How agents should name the file

| Tool | What works |
|---|---|
| Read | the file's path, absolute or relative to the project root |
| Grep | `path` set to the file, absolute or relative |
| Grep `glob` | not exempted — use `path` instead |
| Bash | the **absolute** path only, in a line where every command is read-only: `cat /home/me/app/.env.production` |

Bash needs the absolute path because a bare name in a shell command is not tied to one
file: after `cd apps/api`, or as a `find -name` pattern, `.env.production` means a
different file, which may hold real credentials. When an exemption is configured, the
guard's refusal of a Bash command says so, so an agent that used a relative name knows
to retry with the absolute one.

Bash also honors an exemption only when every command in the line is one of `cat`, `head`, `tail`, `grep`, `egrep`, `fgrep`, `rg`, `wc`, `diff`, `cmp`, `sort`, `uniq`, `cut`, `nl` or `od`, with no `$( )`, backtick or `<( )` body. Any other command in the line (`mv`, `ln`, `cp`, `git`, `awk`, `sed`, a shell or interpreter) withdraws the exemption for the whole line: `cat /abs/.env.production | grep KEY` is allowed, `mv a b && cat /abs/.env.production` is refused.

## When the read is still refused

| Situation | Why | What to do |
|---|---|---|
| Not committed, or only staged | the guard checks `HEAD` | commit the file |
| Committed as a symlink, or replaced by one on disk | a symlink can point at a real secret | commit and keep a regular file |
| Path in config does not match | matching is exact and case-sensitive (case-insensitive on Windows only) | list the path exactly as it is in the repository |
| `config-set` changed a workstream config | the guard reads only the root `.planning/config.json` | set the key in the root config |
| Not a git repository | the guard cannot confirm the file is committed | run inside the repository |
| The repository is SHA-256, shallow/partial and missing the object, or its objects live only in alternates | the guard reads git's own files and cannot confirm the file | run in a normal clone |
| Bash with a relative name | see above | use the absolute path, or the Read tool |
| Bash line that also runs a command outside the read-only list | any other command withdraws the exemption for the line | run the read alone, or use the Read tool |
| File inside a submodule | the submodule's `.git` file is not followed | not supported |

## Removing an exemption

```sh
gsd-tools config-set hooks.secret_read_exempt '[]'
```

The file is blocked again on the next tool call.
