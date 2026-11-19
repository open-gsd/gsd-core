'use strict';

// Shared fixture for the #5482 engine backstop: an ACTIVE overlay capability (no consent gate, no
// activation key) declaring blocking `ship:pre` gates, run under a clean HOME/XDG so the user's real
// capabilities cannot leak in.
const fs = require('node:fs');
const path = require('node:path');

const GATE_ROADMAP = '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: Build\n**Goal:** Build\n';

function writeGateCap(home, { command, predicate, blocking = true, onError = 'halt', gates }) {
  const capDir = path.join(home, '.gsd', 'capabilities', 'open-work');
  fs.mkdirSync(capDir, { recursive: true });
  fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify({
    id: 'open-work', role: 'feature', version: '1.0.0', title: 'Open Work',
    description: '#5482 engine backstop fixture', tier: 'standard', requires: [],
    engines: { gsd: '>=0.0.0' }, runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [],
    gates: (gates ?? [{ check: { predicate: predicate ?? { kind: 'command-exit-zero', command } }, blocking, onError }])
      .map((g) => ({ point: 'ship:pre', ...g })),
  }));
}

function cleanEnv(home) {
  return {
    HOME: home, GSD_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
  };
}

module.exports = { GATE_ROADMAP, writeGateCap, cleanEnv };
