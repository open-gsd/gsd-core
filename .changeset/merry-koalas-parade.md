---
type: Security
pr: 5842
---
**Known advisories in the lockfile are patched** — the re2js regex engine and the @hono/node-server transitive dependency are now at their fixed versions, closing the high re2js denial-of-service advisory and the moderate @hono/node-server middleware-bypass advisory for every install that resolves the lockfile. (#5840)
