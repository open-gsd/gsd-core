---
type: Security
pr: 113
---
**Scanner now detects malicious markdown link schemes** — `scanForInjection()` previously passed markdown links containing `javascript:`, `data:` (non-image/font), `https://user:pass@host` userinfo credentials, and sensitive query-string key names (`token=`, `api_key=`, etc.) as clean. Four new rules (`MD-LINK-JS-SCHEME`, `MD-LINK-DATA-SCHEME`, `MD-LINK-USERINFO`, `MD-LINK-TOKEN-IN-QUERY`) now flag these patterns in both the scanner and the `gsd-read-injection-scanner.js` hook. The `data:` safe-list permits image and font MIME types; `data:image/svg+xml` is intentionally blocked because SVG can host inline scripts.
