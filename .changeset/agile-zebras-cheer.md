---
type: Fixed
pr: 5712
---
**Antigravity agents start again in agy 1.3.5** — installed agent tool lists now use the names agy registers (write_to_file, find_by_name, search_web, read_url_content), TodoWrite is no longer emitted, and agents whose tools are a YAML block list (gsd-security-auditor, gsd-nyquist-auditor) keep every tool instead of collapsing to one nested entry (#5447).
