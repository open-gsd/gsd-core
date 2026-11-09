## Cleanup-tail snippet

```bash
# Cleanup-tail: pin orchestrator CWD to its OWN worktree before cleanup-tail (#3174, #630).
# Resolves orchestrator_root from manifest (see execute-phase/steps/executor-isolation-dispatch.md).
PRIMARY_WT=$(MANIFEST="$WAVE_WORKTREE_MANIFEST" node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"));if(j&&j.orchestrator_root){let r=String(j.orchestrator_root);let realpathFailed=false;try{r=fs.realpathSync.native(r)}catch(e){realpathFailed=true}if(process.platform==="win32"){r=r.replace(/\\/g,"/")}if(realpathFailed){console.error("FATAL: realpath failed for orchestrator_root: "+r);process.exit(2)}process.stdout.write(r)}}catch(e){}') || { echo "FATAL: realpath failed for orchestrator_root in the wave manifest" >&2; exit 1; }
[ -n "$PRIMARY_WT" ] || PRIMARY_WT=$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')
_WT_GREP_FLAGS="-qFx"; node -e "process.exit(process.platform==='win32'?0:1)" && _WT_GREP_FLAGS="-qiFx"; git worktree list --porcelain | tr -d '\r' | grep $_WT_GREP_FLAGS "worktree $PRIMARY_WT" || { echo "FATAL: orchestrator_root in manifest is not a registered worktree: '$PRIMARY_WT'" >&2; exit 1; }
if [ -n "$PRIMARY_WT" ] && [ "$(pwd -P 2>/dev/null)" != "$(cd "$PRIMARY_WT" 2>/dev/null && pwd -P)" ]; then echo "⚠ Orchestrator CWD drifted to $(pwd) — pinning to $PRIMARY_WT before cleanup-tail (#3174)"; cd "$PRIMARY_WT" || { echo "FATAL: cannot cd to primary worktree $PRIMARY_WT" >&2; exit 1; }; fi
# Cleanup-tail: remove residual agent worktrees after a cross-wave-dependency deviation.
# Uses only the current wave manifest to avoid touching unrelated active agents (#3384).
WT_PATHS_FILE=$(mktemp "${TMPDIR:-/tmp}/gsd-worktree-paths-XXXXXX")
node -e 'const fs=require("fs");const p=process.env.WAVE_WORKTREE_MANIFEST;try{if(!p)throw new Error("WAVE_WORKTREE_MANIFEST is unset");if(!fs.existsSync(p))throw new Error("manifest does not exist");const s=fs.readFileSync(p,"utf8");if(!s.trim())throw new Error("manifest is empty");const j=JSON.parse(s);for(const w of j.worktrees||[])if(w.worktree_path)console.log(w.worktree_path)}catch(e){console.error(`ERROR: cannot read worktree manifest ${p||"(unset)"}: ${e.message}`);process.exit(1)}' > "$WT_PATHS_FILE" || { echo "BLOCKED: cannot read WAVE_WORKTREE_MANIFEST; refusing cleanup (#3384)." >&2; exit 1; }
CLEANUP_FAILED=0
while IFS= read -r WT; do
  [ -z "$WT" ] && continue
  WT_BRANCH=$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null)
  [ -z "$WT_BRANCH" ] || [ "$WT_BRANCH" = "HEAD" ] && continue
  echo "Cleaning up residual worktree: $WT (branch: $WT_BRANCH)"
  git worktree unlock "$WT" 2>/dev/null || true
  if ! git worktree remove "$WT" --force; then
    CLEANUP_FAILED=1
    WT_NAME=$(basename "$WT")
    if [ -f ".git/worktrees/${WT_NAME}/locked" ]; then
      echo "⚠ Worktree $WT is locked — unlock failed; manual cleanup required:"
      echo "    git worktree unlock \"$WT\" && git worktree remove \"$WT\" --force && git branch -D \"$WT_BRANCH\""
    else
      echo "⚠ Residual worktree at $WT — remove failed; manual cleanup required"
    fi
  else
    git branch -D "$WT_BRANCH" 2>/dev/null || true
  fi
done < "$WT_PATHS_FILE"
rm -f "$WT_PATHS_FILE"
git worktree prune
RESIDUAL_OWNED=0
if [ "$CLEANUP_FAILED" -eq 0 ]; then
  RESIDUAL_OWNED=$(gsd_run query worktree.residual-owned --manifest "$WAVE_WORKTREE_MANIFEST" --raw) || { echo "⚠ could not list worktrees; preserving manifest at $WAVE_WORKTREE_MANIFEST" >&2; CLEANUP_FAILED=1; RESIDUAL_OWNED=1; }
fi
if [ "$CLEANUP_FAILED" -eq 0 ] && [ ! -L "$WAVE_WORKTREE_MANIFEST" ] && ! git ls-files --error-unmatch "$WAVE_WORKTREE_MANIFEST" >/dev/null 2>&1 && [ "$RESIDUAL_OWNED" = "0" ]; then
  rm -f "$WAVE_WORKTREE_MANIFEST"
  unset WAVE_WORKTREE_MANIFEST
else
  echo "⚠ Residual worktrees remain; preserving manifest at $WAVE_WORKTREE_MANIFEST for reconciliation." >&2
fi
```
