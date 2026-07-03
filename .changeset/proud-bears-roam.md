---
type: Added
pr: 1923
---
OpenCode now runs GSD's lifecycle safety hooks (prompt-injection guard, read-before-edit guard, injection scanner, worktree/workflow guards, context monitor) via a native plugin installed to `~/.config/opencode/plugins/gsd-core.js`. OpenCode declares `hooksSurface: 'none'`, so these hooks were previously inert; the plugin bridges OpenCode's event bus onto GSD's existing hook scripts. Installed automatically by `npx @opengsd/gsd-core --opencode` and removed on uninstall.
