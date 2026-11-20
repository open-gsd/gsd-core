---
type: Fixed
pr: 0
---
**The secret-read guard denies a secret read that `cat` prints from a heredoc or here-string into a shell** — `cat <<'EOF' | bash` with `cat .env` in the body, `cat <<< 'cat .env' | bash`, `bash <(cat <<EOF …)` and `source <(cat <<< '…')` are scanned like the same text given to the shell directly, while the same bodies given to `wc -l` or a bare `cat` stay allowed. (#6182)
