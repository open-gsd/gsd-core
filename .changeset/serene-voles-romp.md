---
type: Fixed
pr: 5661
---
**OpenAI-compatible reviewer lanes no longer follow redirects** — the model-discovery and completions requests of an openai-http lane (ollama, lm_studio, llama_cpp, installed third-party lanes) could be redirected to a host you never configured, sending the review prompt, which may carry repository content, there. A 3xx response now fails the lane and names the redirect target host; set the lane's host to the final URL. (#5433)
