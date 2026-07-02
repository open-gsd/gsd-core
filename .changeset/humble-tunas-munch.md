---
type: Fixed
pr: 1807
---
reconstructFrontmatter now emits valid YAML for scalars and block-array items that were previously serialized unescaped. Values carrying a YAML indicator plus a literal quote/backslash, embedded control characters, the empty string, a leading YAML indicator, or leading/trailing whitespace are now routed through a properly escaped double-quoted form, so frontmatter round-trips through strict parsers (js-yaml, PyYAML) instead of corrupting the block on the next state sync.
