# Cleanup tail

## Cleanup-tail snippet

```bash
# Cleanup-tail: pin orchestrator CWD to its OWN worktree before cleanup-tail (#3174, #630).
# Resolves orchestrator_root from manifest (see execute-phase/steps/executor-isolation-dispatch.md).
if [ ! -f "${WAVE_WORKTREE_MANIFEST:-}" ] || [ -L "$WAVE_WORKTREE_MANIFEST" ]; then
  echo "BLOCKED: cleanup requires a regular, non-symlink wave manifest" >&2
  exit 1
fi
PRIMARY_WT=$(MANIFEST="$WAVE_WORKTREE_MANIFEST" node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"));if(j&&j.orchestrator_root){let r=String(j.orchestrator_root);let realpathFailed=false;try{r=fs.realpathSync.native(r)}catch(e){realpathFailed=true}if(process.platform==="win32"){r=r.replace(/\\/g,"/")}if(realpathFailed){console.error("FATAL: realpath failed for orchestrator_root: "+r);process.exit(2)}process.stdout.write(r)}}catch(e){}') || { echo "FATAL: realpath failed for orchestrator_root in the wave manifest" >&2; exit 1; }
[ -n "$PRIMARY_WT" ] || PRIMARY_WT=$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')
_WT_GREP_FLAGS="-qFx"; node -e "process.exit(process.platform==='win32'?0:1)" && _WT_GREP_FLAGS="-qiFx"; git worktree list --porcelain | tr -d '\r' | grep $_WT_GREP_FLAGS "worktree $PRIMARY_WT" || { echo "FATAL: orchestrator_root in manifest is not a registered worktree: '$PRIMARY_WT'" >&2; exit 1; }
if [ -n "$PRIMARY_WT" ] && [ "$(pwd -P 2>/dev/null)" != "$(cd "$PRIMARY_WT" 2>/dev/null && pwd -P)" ]; then echo "⚠ Orchestrator CWD drifted to $(pwd) — pinning to $PRIMARY_WT before cleanup-tail (#3174)"; cd "$PRIMARY_WT" || { echo "FATAL: cannot cd to primary worktree $PRIMARY_WT" >&2; exit 1; }; fi
# Cleanup-tail: remove residual agent worktrees after a cross-wave-dependency deviation.
# Uses only the current wave manifest to avoid touching unrelated active agents (#3384).
if ! WT_TRACKED=$(git ls-files -- "$WAVE_WORKTREE_MANIFEST") || [ -n "$WT_TRACKED" ]; then
  echo "BLOCKED: cleanup requires a confirmed untracked wave manifest" >&2
  exit 1
fi
WT_PATHS_FILE=$(mktemp "${TMPDIR:-/tmp}/gsd-worktree-paths-XXXXXX")
# JavaScript expands the template literal; the shell must leave it untouched.
# shellcheck disable=SC2016
node -e 'const fs=require("fs");const p=process.env.WAVE_WORKTREE_MANIFEST;try{if(!p)throw new Error("WAVE_WORKTREE_MANIFEST is unset");if(!fs.existsSync(p))throw new Error("manifest does not exist");const s=fs.readFileSync(p,"utf8");if(!s.trim())throw new Error("manifest is empty");const j=JSON.parse(s);if(!Array.isArray(j.worktrees)||!j.worktrees.length)throw new Error("empty_manifest");for(const w of j.worktrees){if(typeof w.worktree_path!=="string"||!w.worktree_path||typeof w.branch!=="string"||!w.branch||w.branch.includes("\0")||w.worktree_path.includes("\0"))throw new Error("invalid_manifest_entry");process.stdout.write(w.worktree_path+"\0"+w.branch+"\0")}}catch(e){console.error(`ERROR: cannot read worktree manifest ${p||"(unset)"}: ${e.message}`);process.exit(1)}' > "$WT_PATHS_FILE" || { echo "BLOCKED: cannot read WAVE_WORKTREE_MANIFEST; refusing cleanup (#3384)." >&2; rm -f "$WT_PATHS_FILE"; exit 1; }
CLEANUP_FAILED=0
while IFS= read -r -d "" WT && IFS= read -r -d "" RECORDED_BRANCH; do
  if ! [[ "$RECORDED_BRANCH" =~ ^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$ ]]; then
    echo "⚠ Residual worktree at $WT does not name a recorded agent branch" >&2
    CLEANUP_FAILED=1
    continue
  fi
  if node -e 'try{require("fs").lstatSync(process.argv[1]);process.exit(1)}catch(e){process.exit(e.code==="ENOENT"?0:1)}' "$WT"; then
    if WT_LIST=$(git worktree list --porcelain) &&
       ! printf '%s\n' "$WT_LIST" | tr -d '\r' | grep -Fx "worktree $WT" >/dev/null &&
       ! printf '%s\n' "$WT_LIST" | tr -d '\r' | grep -Fx "branch refs/heads/$RECORDED_BRANCH" >/dev/null; then
      WT_REF_STATUS=0
      git show-ref --verify --quiet "refs/heads/$RECORDED_BRANCH" || WT_REF_STATUS=$?
      if [ "$WT_REF_STATUS" -eq 1 ]; then continue; fi
    fi
  fi
  WT_BRANCH=$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null) || WT_BRANCH=""
  if [ "$WT_BRANCH" = "HEAD" ]; then
    # A detached worktree the manifest lists may hold commits on no branch: keep it, and the manifest.
    echo "⚠ Residual worktree at $WT is detached (no branch) — not removed; manual reconciliation required"
    CLEANUP_FAILED=1
    continue
  fi
  if [ "$WT_BRANCH" != "$RECORDED_BRANCH" ]; then
    echo "⚠ Residual worktree at $WT does not match its recorded agent branch" >&2
    CLEANUP_FAILED=1
    continue
  fi
  if ! WT_STATUS=$(git -C "$WT" status --porcelain) || [ -n "$WT_STATUS" ]; then
    echo "⚠ Residual worktree at $WT is dirty or unreadable" >&2
    CLEANUP_FAILED=1
    continue
  fi
  if ! git merge-base --is-ancestor "refs/heads/$WT_BRANCH" HEAD; then
    echo "⚠ Residual branch $WT_BRANCH is unmerged or unreadable; preserving it and its worktree" >&2
    CLEANUP_FAILED=1
    continue
  fi
  echo "Cleaning up residual worktree: $WT (branch: $WT_BRANCH)"
  git worktree unlock "$WT" 2>/dev/null || true
  if ! git worktree remove "$WT"; then
    CLEANUP_FAILED=1
    WT_NAME=$(basename "$WT")
    if [ -f ".git/worktrees/${WT_NAME}/locked" ]; then
      echo "⚠ Worktree $WT is locked — unlock failed; manual cleanup required:"
      echo "    git worktree unlock \"$WT\" && git worktree remove \"$WT\" && git branch -d \"$WT_BRANCH\""
    else
      echo "⚠ Residual worktree at $WT — remove failed; manual cleanup required"
    fi
  elif ! git branch -d "$WT_BRANCH"; then
    echo "⚠ Could not safely delete branch $WT_BRANCH; preserving it for reconciliation" >&2
    CLEANUP_FAILED=1
  fi
done < "$WT_PATHS_FILE"
rm -f "$WT_PATHS_FILE"
git worktree prune
if [ "$CLEANUP_FAILED" -eq 0 ] && [ ! -L "$WAVE_WORKTREE_MANIFEST" ] &&
   WT_TRACKED=$(git ls-files -- "$WAVE_WORKTREE_MANIFEST") && [ -z "$WT_TRACKED" ]; then
  rm -f "$WAVE_WORKTREE_MANIFEST"
  unset WAVE_WORKTREE_MANIFEST
else
  echo "⚠ Residual worktrees remain; preserving manifest at $WAVE_WORKTREE_MANIFEST for reconciliation." >&2
  exit 1
fi
```
