---
type: Fixed
pr: 6740
---
**The installer now has a flag reference, and `--no-legacy-cleanup`, `--dry-run`, `--both`, `--devin-desktop` and nine runtime flags are documented** — flags were scattered across three guides, `--no-legacy-cleanup` appeared in none, and the runtime table in `docs/manual-update.md` listed 9 of the installer's 18 runtime flags. `docs/reference/installer-flags.md` lists every option, alias and exit status, including that `--gemini` is retired and exits 1. (#6739)
