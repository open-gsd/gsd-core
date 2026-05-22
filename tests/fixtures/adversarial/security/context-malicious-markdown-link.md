# Context

A perfectly normal document with hostile links (one per rule class) and benign controls.

## Hostile links (must be flagged)

<!-- MD-LINK-JS-SCHEME: javascript: URI in link target -->
- [click here](javascript:alert('xss'))

<!-- MD-LINK-DATA-SCHEME: data: text/html URI (not in safe-list) -->
- [download](data:text/html;base64,PHNjcmlwdD5hbGVydCgneHNzJyk8L3NjcmlwdD4=)

<!-- MD-LINK-USERINFO: credentials embedded in URL authority -->
- [credentials](https://user:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@example.com)

<!-- MD-LINK-TOKEN-IN-QUERY: sensitive key in query string -->
- [exfil](https://attacker.example.com/?token=leaked_value)

## Benign controls (must NOT be flagged)

<!-- safe data: image — allowed by safe-list -->
- ![logo](data:image/png;base64,iVBORw0KGgo=)

<!-- mailto: — no userinfo colon-before-at pattern -->
- [email](mailto:user@example.com)

<!-- normal https link with no sensitive query keys -->
- [repo](https://github.com/owner/repo)

<!-- port-in-URL (host:port, not userinfo) -->
- [service](https://example.com:8443/path)
