# SandboxVR Store Map Scenario 2 (`s2-gsd-modern`)

Standalone comparison app for `gsd-core` that demonstrates:

- a placeholder interactive map surface
- a list of SandboxVR store locations
- a detail panel that updates on store selection
- persisted per-store click counts in a local SQLite database

## Stack

- Node.js 22
- Vanilla HTML/CSS/JavaScript
- `better-sqlite3` for local SQLite persistence

## Run

```bash
cd examples/sandboxvr-store-map-s2-gsd-modern
npm install
npm start
```

Then open `http://127.0.0.1:3000`.

The app writes click counts to `var/store-clicks.sqlite` under the example directory.

## Test

```bash
npm test
```

## Smoke validation

```bash
npm run smoke
```

That command starts the app on an ephemeral port, clicks one store through the API, then prints the before/after click counts.

## Notes

- The map is intentionally a placeholder surface with positioned markers rather than a live map provider.
- The store dataset is a fixed scenario seed so the app remains self-contained for controlled comparison work.
