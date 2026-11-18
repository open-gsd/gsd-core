# External review (cursor lane)

Scope: src/messages.js, src/auth.js (same scope as the internal reviewer).

## Findings

### 1. Lockout message contradicts the configured lockout window

**File:** `src/messages.js:5`
`LOCKED` tells the user to "Try again in 15 minutes", but the lockout window is
`LOCKOUT_MINUTES = 30` (`src/config.js:4`, consumed by `src/lockout.js:5`). A locked-out user
retrying after 15 minutes is still locked out.

Fix: derive the text from `LOCKOUT_MINUTES` or change the literal to 30.
