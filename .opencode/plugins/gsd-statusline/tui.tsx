// GSD statusline and update banner for the OpenCode 2.x terminal client (ADR-5331 Phase 3).
//
// A CLI plugin (https://opencode.ai/v2/docs/build/plugins/cli): OpenCode 2.x loads `tui.tsx` from a
// directory under plugins/ and renders the slots registered here. The line itself comes from GSD's own
// hooks/gsd-statusline.js — the script Claude Code runs — so state, progress, git and update-available
// output stay one implementation. OpenCode 1.x never loads this directory (it scans plugins/*.js|ts only).
import { Plugin } from "@opencode/plugin/tui"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REFRESH_MS = 10_000
// Strip terminal colour codes: the host styles its own footer.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function hooksDir() {
  // <config>/plugins/gsd-statusline/tui.tsx  →  <config>/hooks
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks")
}

function runtime() {
  return process.env.GSD_HOOK_RUNTIME || "node"
}

function render(directory: string, model: string, done: (line: string) => void) {
  const script = path.join(hooksDir(), "gsd-statusline.js")
  // Only inside a GSD project, and only when the script is installed.
  if (!existsSync(script) || !existsSync(path.join(directory, ".planning"))) return done("")
  const child = execFile(runtime(), [script], { cwd: directory, timeout: 4000, windowsHide: true }, (error, stdout) => {
    done(error ? "" : String(stdout).replace(ANSI, "").split("\n")[0].trim())
  })
  child.stdin?.end(JSON.stringify({ model: { display_name: model }, workspace: { current_dir: directory } }))
}

export default Plugin.define({
  id: "gsd.statusline",
  setup(context) {
    const directory = context.location?.directory ?? context.data.location.default().directory
    const [state, update] = context.storage.memory("line", { initial: { text: "" } })
    const refresh = () => {
      const selected = context.ui.model.current()
      render(directory, selected?.modelID || "OpenCode", (text) => update((draft: { text: string }) => { draft.text = text }))
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    const stopHome = context.ui.slot({ append: "home.footer.status", render: () => <text>{state.text}</text> })
    const stopPrompt = context.ui.slot({ append: "prompt.footer.status", render: () => <text>{state.text}</text> })
    return () => {
      clearInterval(timer)
      stopHome?.()
      stopPrompt?.()
    }
  },
})
