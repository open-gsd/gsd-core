'use strict';

// The verifier's report examples name the fingerprint version the CLI emits (#6811): `verification fingerprint`
// writes `v<FINGERPRINT_VERSION>:sha256:…`, so the agent prompts and the report template that show a
// covered_digest must show that same version, or a bump leaves the examples teaching the previous one.

const SOURCE = 'src/verification.cts';
const EXAMPLES = [
  'agents/gsd-verifier.md',
  'pi/package-agents/gsd-verifier.md',
  'gsd-core/templates/verification-report.md',
];

module.exports = {
  id: 'verifier-fingerprint-version',
  issue: '#6811',
  check(ctx) {
    const source = ctx.doc(SOURCE).has(/^const FINGERPRINT_VERSION = \d+;$/m, 'the emitted fingerprint version is declared as one integer constant');
    const match = /^const FINGERPRINT_VERSION = (\d+);$/m.exec(source.text);
    if (match === null) return;
    for (const rel of EXAMPLES) {
      ctx.doc(rel)
        .has(`covered_digest: "v${match[1]}:sha256:`, `the covered_digest example must use the emitted version v${match[1]}`)
        .lacks(new RegExp(`covered_digest: "v(?!${match[1]}:)\\d+:sha256:`), 'no covered_digest example may name another version');
    }
  },
};
