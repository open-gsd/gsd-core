# Scenario 4 control app: SandboxVR store map

Standalone spike for scenario `s4-no-super-no-gsd`.

## What it does

- renders a placeholder interactive map surface
- lists seeded SandboxVR store locations
- updates a detail panel when a store is clicked from the list or map
- persists per-store click counts in a local SQLite database

## Run

```bash
cd examples/s4-no-super-no-gsd
npm install
npm start
```

The app starts on `http://127.0.0.1:3000` by default.

## Test

```bash
npm test
```

## Smoke validation

```bash
npm run smoke
```

That command starts the app on a random port, records a click for `sandboxvr-austin`, fetches the stored detail payload, prints the persisted counter, and shuts the server down.
