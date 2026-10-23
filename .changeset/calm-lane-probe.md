---
type: Changed
pr: 5278
---
**`/gsd-review` still detects local review servers (Ollama, LM Studio, llama.cpp) the same way — any HTTP reply, even a 401 behind an API key, reads `available`, and redirects are not followed (#5266)** — host lookup now goes through `review-lane availability`, which replaces three inline probes in `review.md`. Selected local-lane runs likewise treat a non-2xx `/v1/models` reply as reachable. One difference from the old `curl --max-time 2`: a server that sends headers but stalls the body now reads `available` (curl timed out and read `missing`).
