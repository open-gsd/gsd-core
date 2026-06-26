---
type: Fixed
pr: 1736
---
The `<agent_skills>` block emitted by `gsd init` no longer leaks backslash paths into `@`-reference skill paths on Windows. The global skill directory (a native `path.join` result) was interpolated into the generated markdown without POSIX normalization, producing references like `@C:\…\skills\name/SKILL.md`; the reference is now normalized at the emit site so skill references use forward slashes on every platform.
