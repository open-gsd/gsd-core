'use strict';

// Every `config-get` command substitution in shipped content passes `--raw` or is an exempt JSON consumer (#3763).
// `query config-get <key>` without `--raw` prints JSON.stringify(value), so a string value reaches a bash variable with
// embedded quotes and every later `[ "$X" = "y" ]` comparison silently never matches (booleans and numbers are the same
// either way, which is why the string sites survived testing). Exempt shapes: the receiving variable's name ends in
// `_JSON`, or the call carries a JSON-array default (`--default '[]'`). `--raw` must sit in the config-get command
// itself, before any `||` fallback. The scan self-checks that it saw more than 20 substitutions, so a rotted scan root
// or matcher fails instead of passing over nothing. Was tests/config-get-raw-guard.test.cjs.

const SCAN_ROOTS = ['gsd-core/workflows', 'commands', 'agents', 'skills'];
const SUBSTITUTION_RE = /\$\([^)]{0,2000}config-get[^)]{0,2000}\)/g;
const MIN_SUBSTITUTIONS = 20;

module.exports = {
  id: 'config-get-raw-guard',
  issue: '#3763',
  check(ctx) {
    let scanned = 0;
    let lastDoc = null;
    for (const root of SCAN_ROOTS) {
      for (const rel of ctx.list(root, '.md', 'the shipped content is what the config-get scan covers')) {
        lastDoc = ctx.doc(rel).satisfies((text) => {
          const offenders = [];
          text.split('\n').forEach((line, i) => {
            if (!line.includes('config-get')) return;
            for (const sub of line.match(SUBSTITUTION_RE) || []) {
              scanned += 1;
              const bar = sub.indexOf('||');
              if (sub.slice(0, bar >= 0 ? bar : sub.length).includes('--raw')) continue;
              const assignment = /^[ \t]{0,50}[A-Za-z_][A-Za-z0-9_]{0,200}=/.exec(line);
              const varName = assignment ? assignment[0].trimEnd().slice(0, -1) : '';
              if (varName.endsWith('_JSON')) continue;
              if (/--default[ \t]{1,20}('\[\]'|"\[\]")/.test(sub)) continue;
              offenders.push(`line ${i + 1}: ${line.trim()}`);
            }
          });
          return offenders.length === 0 || offenders.join('; ');
        }, 'a config-get command substitution without --raw feeds JSON.stringify output into bash string comparisons (they silently never match for string values): add --raw, or rename the receiving variable to *_JSON, or pass a "[]" default if the consumer parses JSON');
      }
    }
    if (lastDoc) {
      lastDoc.satisfies(() => scanned > MIN_SUBSTITUTIONS || `scanned ${scanned}`, `guard self-check: expected to scan more than ${MIN_SUBSTITUTIONS} config-get substitutions; the scan roots or the matcher rotted`);
    }
  },
};
