#!/usr/bin/env bash
# check.sh <trialdir> : RETAINED=1 if the new REVIEW.md has a finding on src/messages.js:5 / the LOCKOUT mismatch;
# TAGGED=1 if that finding carries '(external: cursor)'.
set -euo pipefail
R=${1:?trialdir}/project/phase/01-REVIEW.md
[ -f "$R" ] || { echo "no $R" >&2; exit 2; }
# trial.sh/iter3.sh store the cksum of the review the reviewer was given; an unchanged file means it wrote only in chat.
[ "$(cksum < "$R")" != "$(cat "$1/pre.cksum" 2>/dev/null)" ] || { echo "reviewer wrote no new review: $R" >&2; exit 2; }
node -e '
const t = require("fs").readFileSync(process.argv[1], "utf8").replace(/\r\n/g, "\n");
const secs = t.split(/^(?=#{2,4} (?:CR|WR|IN|BL)-\d+)/m).filter((s) => /^#{2,4} (?:CR|WR|IN|BL)-\d+/.test(s));
const hit = secs.filter((s) => (/LOCKOUT_MINUTES|config\.js/.test(s) && /\b30\b/.test(s)) || (/\b15[\s-]*min/.test(s) && /\b30\b/.test(s)));
console.log("RETAINED=" + (hit.length ? 1 : 0));
console.log("TAGGED=" + (hit.some((s) => /\(\s*external\s*:\s*cursor\s*\)/i.test(s)) ? 1 : 0));
' "$R"
