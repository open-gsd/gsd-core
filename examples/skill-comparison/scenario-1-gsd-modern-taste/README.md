# SandboxVR Store Map — Scenario 1

Standalone comparison app for the **gsd-core + modern-web-guidance + design-taste-frontend** scenario.

## What it does
- Renders a polished placeholder map surface with clickable venue markers
- Lists SandboxVR store locations
- Updates a detail panel when a store is selected
- Persists per-store click counts in local SQLite

## Run
```bash
cd experiments/sandboxvr-store-map-s1
npm install
npm start
```

Open `http://127.0.0.1:3000`.

## Test
```bash
cd experiments/sandboxvr-store-map-s1
npm test
```

## Smoke
```bash
cd experiments/sandboxvr-store-map-s1
npm run smoke
```

## Notes
- Uses a placeholder map instead of a third-party provider.
- Uses a fixed local store seed so the scenario is reproducible.
