---
type: Added
pr: 2174
---
**Opt-in absolute token count on the statusline context meter** — new `statusline.show_context_tokens` config (default `false`). When enabled, the meter shows the absolute context total after the percentage, e.g. "████░░░░░░ 46% (156k)", summing input, cache-creation, cache-read, and output tokens from the hook payload (a broader basis than the meter's percentage, which is derived from `used_percentage` and excludes output tokens — the two figures can diverge slightly). Default meter output is unchanged. (#2161)
