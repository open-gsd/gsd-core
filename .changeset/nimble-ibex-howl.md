---
type: Fixed
pr: 0
---
**Local reviewer lanes no longer report an unrelated default-port service as available** — with `review.llama_cpp_host`, `review.lm_studio_host` or `review.ollama_host` unset, an unrelated local service answering 404, 401 or a redirect on `:8080`, `:1234` or `:11434` made the lane look available and the review prompt was sent to it; a default host now counts as available only when it answers `/v1/models` with an OpenAI-style models listing, while a host you configure keeps the any-answer rule. (#5963)
