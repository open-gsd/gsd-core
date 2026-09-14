'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const root = path.resolve(__dirname, '..');
const steps = path.join(root, 'gsd-core', 'workflows', 'quick-batch', 'steps');
const read = (name) => fs.readFileSync(path.join(steps, name), 'utf8');
const lifecycle = read('opencode-v2-lifecycle.md');
const dispatch = read('opencode-v2-dispatch.md');
const merge = read('opencode-v2-merge.md');
const verify = read('opencode-v2-verification.md');
const completion = read('opencode-v2-completion.md');

function ordered(text, needles) {
  let at = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, at + 1);
    assert.ok(next > at, `expected ordered marker: ${needle}`);
    at = next;
  }
}

test('native lifecycle retains same-parent reconciliation and wake-up-only restart contract', () => {
  assert.match(lifecycle, /same current parent calls `recover`/);
  assert.match(lifecycle, /notification is only a wake-up signal/);
  assert.match(lifecycle, /same canonical\s+project/);
  assert.match(lifecycle, /Never poll, infer completion from files, or invoke a wait action/);
});

test('native dispatch allocates one round, starts exact identities, and seals once', () => {
  ordered(dispatch, ['v2-reconcile', 'v2-allocate', '--phase create_intent', 'worktree.create', '--phase start_intent', '"action":"start"', '--phase seal_intent', '"action":"seal"', '--phase sealed']);
  assert.equal((dispatch.match(/WAVE_ID="qb-/g) || []).length, 1);
  assert.equal((dispatch.match(/"action":"seal"/g) || []).length, 1);
  assert.match(dispatch, /SESSION_ID_1[\s\S]*SESSION_ID_N/);
  assert.match(dispatch, /PROVIDER="\$\{MODEL_SELECTOR%%\/\*\}"/);
  assert.match(dispatch, /BARE_MODEL="\$\{MODEL_AND_VARIANT%%#\*\}"/);
  assert.match(dispatch, /medium\|high/);
  assert.match(dispatch, /Do not call status now/);
  assert.match(dispatch, /Never invoke `wait`, poll status, run `opencode run`, create a detached session,\s+use `session_move`/);
});

test('native V2 worktrees use the established external ignored root without requiring it to exist', () => {
  assert.match(dispatch, /WT_PATH="\$\{ORCHESTRATOR_WT\}\/.claude\/worktrees\/\$\{MANIFEST_AGENT_ID\}"/);
  assert.match(dispatch, /process\.stdout\.write\(p\.resolve\(process\.env\.WT_PATH\)\)/);
  assert.doesNotMatch(dispatch, /realpathSync/);
  assert.match(merge, /--worktree-root "\$\{ORCHESTRATOR_WT\}\/.claude\/worktrees"/);
  for (const fragment of [lifecycle, dispatch, merge, verify, completion]) {
    assert.doesNotMatch(fragment, /\.opencode\/worktrees/);
  }
});

test('native V2 encodes cleanup scope for the legacy worktree.create flags, never as JSON arrays', () => {
  assert.match(dispatch, /`worktree\.create` parses each scope flag as one whitespace-separated string,\s+# not JSON/);
  assert.match(dispatch, /PLAN_FILES=\$\(PLAN_ENTRY_JSON="\$PLAN_ENTRY_JSON" node -e/);
  assert.match(dispatch, /PLAN_DELETIONS=\$\(PLAN_ENTRY_JSON="\$PLAN_ENTRY_JSON" node -e/);
  assert.match(dispatch, /paths\.join\(" "\)/);
  assert.match(dispatch, /non-empty whitespace-free paths/);
  assert.match(dispatch, /if \[ -n "\$PLAN_DELETIONS" \]; then[\s\S]*--files "\$PLAN_FILES" --deletions "\$PLAN_DELETIONS" --raw[\s\S]*else[\s\S]*--files "\$PLAN_FILES" --raw/);
  assert.doesNotMatch(dispatch, /JSON arrays passed unchanged to worktree\.create/);
  assert.doesNotMatch(dispatch, /--files "\$PLAN_ENTRY_JSON"|--deletions "\$PLAN_ENTRY_JSON"/);
});

test('native merge performs both fresh attestations, all merges, then teardown', () => {
  ordered(merge, ['### Fresh gate before prepare', '{"action":"recover"}', '{"action":"status","wave_id":"{WAVE_ID}"}', 'quick-batch v2-attest', '--phase merge_intent', '### Fresh gate immediately before mutation', '{"action":"recover"}', '{"action":"status","wave_id":"{WAVE_ID}"}', 'quick-batch v2-attest', 'quick-batch v2-merge', '### Teardown only after every durable merge', 'quick-batch v2-teardown']);
  assert.match(merge, /model\s+must literally observe[\s\S]*merge_ready:true/);
  assert.match(merge, /validates the entire sealed status job set[\s\S]*only then selects exactly one job/);
  const teardown = merge.slice(merge.indexOf('### Teardown only after every durable merge'));
  assert.doesNotMatch(teardown, /"action":"status"/);
  assert.match(merge, /Never use `reset --hard`/);
});

test('native verification and completion are durable receipt-backed routes', () => {
  assert.match(verify, /exactly one pre-receipt read[\s\S]*hashes the same\s+captured buffer/);
  assert.match(verify, /no receipt, no BATCH outcome mutation/);
  assert.match(verify, /verification_failed[\s\S]*verification_blocked/);
  assert.match(verify, /quick-batch v2-verify/);
  ordered(completion, ['quick-batch v2-complete', '--phase completed', 'quick-batch v2-close', 'quick-batch v2-cleanup']);
  assert.match(completion, /failed, blocked, or unfinished, halt and preserve the active round/);
  assert.match(completion, /atomically embeds that complete receipt in index history/);
  assert.match(completion, /never broad deletion/);
});

test('shared quick-batch fragments are short guarded native delegators', () => {
  const shared = ['worktree-dispatch.md', 'merge-wave.md', 'verification-wave.md', 'completion.md'];
  for (const name of shared) {
    const source = read(name);
    assert.match(source, /## Native-tool guard — first action[\s\S]*opencode-v2-/);
    assert.ok(splitLines(source).length <= 185, `${name} must not retain a V2 appendix`);
  }
  const host = fs.readFileSync(path.join(root, 'gsd-core', 'workflows', 'quick-batch.md'), 'utf8');
  assert.match(host, /opencode-v2-lifecycle\.md/);
  assert.ok(splitLines(host).length <= 235, 'shared quick-batch host must stay compact');
});

test('pre-mutation transport discriminator precedes generic Step 6 effects and native route skips generic Steps 6–9', () => {
  const host = fs.readFileSync(path.join(root, 'gsd-core', 'workflows', 'quick-batch.md'), 'utf8');
  const probe = host.indexOf('**Step 5.5: Resolve executor transport before Step 6');
  const genericDispatch = host.indexOf('**Step 6: Worktree create + executor dispatch (generic route only)**');
  assert.ok(probe >= 0 && genericDispatch > probe, 'transport must resolve before generic Step 6');
  const probeBlock = host.slice(probe, genericDispatch);
  assert.match(probeBlock, /dispatch-isolation --json --cwd-target "\$ORCHESTRATOR_WT"/);
  const probeCommand = splitLines(probeBlock).find((line) => line.includes('dispatch-isolation --json'));
  assert.ok(probeCommand, 'missing pre-mutation transport probe');
  assert.doesNotMatch(probeCommand, /--prompt/);
  assert.match(probeBlock, /normal\s+idempotent isolation-sentinel persistence/);
  assert.match(probeBlock, /no worktree\s+create, BATCH mutation, or executor dispatch/);
  assert.match(probeBlock, /e\.tool==="gsd_worktree_task"/);
  assert.match(probeBlock, /e\.transport==="process"/);
  assert.match(probeBlock, /not-orchestrator/);
  assert.match(probeBlock, /skip generic Steps 6–9 entirely/);
  assert.doesNotMatch(probeBlock, /RUNTIME\s*=/);
});

test('native lifecycle explicitly owns dispatch → merge → optional verification → completion', () => {
  ordered(lifecycle, [
    '## Exclusive native Step 6–9 loop',
    'steps/opencode-v2-dispatch.md',
    'steps/opencode-v2-merge.md',
    'If `$VALIDATE_MODE`, `steps/opencode-v2-verification.md`',
    'steps/opencode-v2-completion.md',
  ]);
  assert.match(lifecycle, /do \*\*not\*\* read or execute generic[\s\S]*worktree-dispatch\.md[\s\S]*merge-wave\.md[\s\S]*verification-wave\.md[\s\S]*completion\.md/);
  assert.match(lifecycle, /never falls\s+through to the generic Steps 6–9/);
});

test('opencode-v2-process-preservation', () => {
  const product = fs.readFileSync(path.join(root, 'docs', 'opencode-v2-worktree-transport.md'), 'utf8');

  assert.match(lifecycle, /Process-based\s+`orchestrator-worktree` hosts retain the separate generic route/);
  assert.match(product, /Claude, Codex, Kilo, Kimi, and other process-based runtimes retain their\s+descriptor-selected process argv\/cwd behavior/);
  assert.match(dispatch, /Never invoke `wait`, poll status, run `opencode run`, create a detached session,\s+use `session_move`/);
  assert.match(
    product,
    /The native route preserves every non-OpenCode process descriptor and process-local execution contract unchanged\./,
    'T-D must explicitly preserve non-OpenCode process-local execution contracts',
  );
});

test('every shared native guard runs before generic content or mutation', () => {
  const cases = [
    ['worktree-dispatch.md', 'worktree.base-check'],
    ['merge-wave.md', 'Skip entirely if `$ISOLATION'],
    ['verification-wave.md', 'Skip this step entirely if NOT `$VALIDATE_MODE`'],
    ['completion.md', 'quick-batch complete'],
  ];
  for (const [name, genericMarker] of cases) {
    const source = read(name);
    const guard = source.indexOf('## Native-tool guard — first action');
    const generic = source.indexOf(genericMarker, guard + 1);
    assert.ok(guard >= 0 && generic > guard, `${name} guard must precede generic content`);
    assert.match(source.slice(guard, generic), /stop processing this shared file/);
  }
});
