# UI audit: static screenshot capture

The capture block `gsd-ui-auditor` runs in its Step 3. Run it as written from the project root with `PADDED_PHASE` set (the zero-padded phase number); it needs `curl` and `npx playwright`.

```bash
# Probe ports in the order 3000, 5173 (Vite default), 8080 (DEV_PORTS overrides). -L follows redirects, any answer
# other than "no connection" (000) or a 5xx counts as a server (auth-gated and redirecting
# servers included), and --max-time keeps an accept-but-never-respond port from hanging.
DEV_URL=""
SCREENSHOT_DIR=""
# DEV_PORTS is reduced to its digit runs before it is word-split, so it can only ever name ports: no glob
# character, path or URL fragment in it survives into the loop or the probed URL.
for PORT in $(printf '%s' "${DEV_PORTS:-3000 5173 8080}" | tr -cs '0-9' ' '); do
  DEV_STATUS=$(curl -sL --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:$PORT" 2>/dev/null) || DEV_STATUS="000"
  case "$DEV_STATUS" in
    000|"" | 5*) ;;
    *) DEV_URL="http://localhost:$PORT"; break ;;
  esac
done

if [ -n "$DEV_URL" ]; then
  SCREENSHOT_DIR=".planning/ui-reviews/${PADDED_PHASE}-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$SCREENSHOT_DIR"
  SHOTS_OK=0

  # A capture counts only when playwright exits 0 AND the file it wrote is non-empty.
  for SHOT in desktop:1440,900 mobile:375,812 tablet:768,1024; do
    SHOT_NAME="${SHOT%%:*}"
    SHOT_SIZE="${SHOT#*:}"
    if npx playwright screenshot "$DEV_URL" "$SCREENSHOT_DIR/$SHOT_NAME.png" \
        --viewport-size="$SHOT_SIZE" --timeout=30000 </dev/null >/dev/null 2>&1 \
        && [ -s "$SCREENSHOT_DIR/$SHOT_NAME.png" ]; then
      SHOTS_OK=$((SHOTS_OK + 1))
    else
      rm -f "$SCREENSHOT_DIR/$SHOT_NAME.png"
      echo "Screenshot FAILED: $SHOT_NAME ($SHOT_SIZE) from $DEV_URL"
    fi
  done

  if [ "$SHOTS_OK" -eq 3 ]; then
    echo "Screenshots captured (3/3) to $SCREENSHOT_DIR"
  elif [ "$SHOTS_OK" -gt 0 ]; then
    echo "Screenshots PARTIAL ($SHOTS_OK/3) in $SCREENSHOT_DIR"
  else
    echo "Screenshots NOT captured: $DEV_URL answered but every capture failed (is Playwright provisioned?) — code-only audit"
  fi
else
  echo "No dev server on localhost:3000, 5173 or 8080 — code-only audit"
fi
```

The block probes port 3000 first, then 5173 (Vite default), then 8080 (`DEV_PORTS` overrides). Any answer other than "no connection" or a 5xx counts as a dev server, so redirecting and auth-gated servers are included; a capture counts only when playwright exits 0 and the file it wrote is non-empty. Its last line is its outcome: `captured`, `PARTIAL` or `NOT captured` (or `No dev server` when nothing answered).
