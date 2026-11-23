'use strict';

// package.json's "files" field lists the whole hooks/ directory, not the narrow hooks/dist entry, and the three
// .sh hook files exist in hooks/ (#1852, #1862): "hooks/dist" bundled only the compiled .js files, so a fresh install
// from the registry got broken shell hooks (SessionStart / PostToolUse errors). Was tests/package-manifest.test.cjs.

const SH_HOOKS = ['gsd-session-state.sh', 'gsd-validate-commit.sh', 'gsd-phase-boundary.sh'];

// package.json "files", or the reason it cannot be read.
function filesField(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'package.json is not a JSON object' };
    return Array.isArray(parsed.files) ? { files: parsed.files } : { error: 'package.json has no "files" array' };
  } catch (err) {
    return { error: `package.json is not valid JSON: ${err.message}` };
  }
}

module.exports = {
  id: 'package-manifest',
  issue: '#1852',
  check(ctx) {
    ctx.doc('package.json')
      .satisfies((text) => {
        const found = filesField(text);
        return found.error || !found.files.includes('hooks/dist') || '"hooks/dist" is in "files"';
      }, '"hooks/dist" must not appear alone in package.json "files": it bundles only the compiled .js files and excludes the .sh hooks in hooks/')
      .satisfies((text) => {
        const found = filesField(text);
        if (found.error) return found.error;
        return found.files.includes('hooks') || `"files" is ${JSON.stringify(found.files)}`;
      }, '"hooks" must be listed in package.json "files" so the .sh hook files are in the npm tarball');
    for (const hook of SH_HOOKS) {
      ctx.exists(`hooks/${hook}`, `${hook} must exist at hooks/${hook} so it is packed with the "hooks" directory`);
    }
  },
};
