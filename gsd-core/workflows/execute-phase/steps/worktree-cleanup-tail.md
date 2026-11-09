# Cleanup-tail runtime setup

Run both bash blocks in order.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
```

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
# JavaScript expands the template literal; the shell must leave it untouched.
# shellcheck disable=SC2016
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
