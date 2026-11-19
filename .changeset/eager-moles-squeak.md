---
type: Changed
pr: 5942
---
**The secret-read guard says why it denies `--env-file` under node, bun, deno and `uv run`** — `node --env-file .env.local app.js` stays denied (the program it starts is usually one the agent just wrote and can print `process.env`), while the #4639 container exemption for `docker`, `docker compose`, `podman` and `nerdctl` is unchanged. The denial now has its own code, `env-file-secret`, and its message says the flag loads a secret file into the process environment and to run the command with a non-secret file (`.env.example`) or ask the user for the values, instead of reporting that Bash would read the file. (#5885)
