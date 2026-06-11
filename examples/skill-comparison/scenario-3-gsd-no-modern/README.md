# SandboxVR Store Map Scenario App

Standalone scenario-3 comparison app for `poc-store-map-s3-gsd-no-modern`.

## What it does

- renders a placeholder interactive map surface
- lists sample SandboxVR store locations used for this scenario
- shows a detail panel for the selected store
- logs each store click into a local SQLite database and displays persisted click counts

## Stack

- Node.js 22
- native `node:http` server
- plain HTML/CSS/JavaScript frontend
- SQLite via `better-sqlite3`
- `node:test` + `jsdom` for focused tests

## Run

```bash
cd examples/sandboxvr-store-map
npm install
npm start
```

Open `http://127.0.0.1:3030`.

## Test

```bash
cd examples/sandboxvr-store-map
npm test
```

## Smoke validation

```bash
cd examples/sandboxvr-store-map
npm run smoke:click
```

That command starts the server against a temporary SQLite file, fetches the store list, clicks the first store via the API, and prints the persisted count.

## Notes

- This is intentionally a standalone spike under `examples/`, not integrated into the repo's existing CLI or SDK packages.
- The store dataset is a static sample seed for the controlled comparison scenario.
