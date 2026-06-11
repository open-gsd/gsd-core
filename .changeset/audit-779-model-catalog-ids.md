---
type: Changed
pr: 779
---
audit(#779): correct stale model-catalog IDs verified against live provider sources. The gemini opus default `gemini-3-pro` → `gemini-3.1-pro-preview` (the bare `gemini-3-pro` ID is undefined in gemini-cli source — only `gemini-3-pro-preview`/`gemini-3.1-pro-preview` exist) and the codex sonnet default `gpt-5.3-codex` → `gpt-5.4` (deprecated per OpenAI's Codex models page); the same two IDs are also updated in the `google`/`openai` provider-preset entries. `qwen3-coder-next` was verified valid (callable on Alibaba Model Studio) and left unchanged. Adds a regression guard against the retired IDs and a sourcing/verification note in CONFIGURATION.md. Catalog IDs are internal defaults; users who pinned the old IDs must update their config.
