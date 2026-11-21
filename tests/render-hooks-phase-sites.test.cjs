'use strict';

/**
 * #4030: pins each code of scripts/static-checks/render-hooks-phase-sites.cjs on failing input.
 * The static check itself runs in scripts/run-static-checks.cjs (ADR-6315 item 19); these tests
 * hold its detection cases, as tests/fold-helper-shadowing.test.cjs does for its check. Every
 * assertion reads the typed `code` of a row, never its prose; the passing fence of each pair is
 * the positive control.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');
const { joinContinuations, RENDER_HOOKS_VERIFY_POST_RE } = require('../scripts/lint-verify-lifecycle-writes.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const phaseSites = require('../scripts/static-checks/render-hooks-phase-sites.cjs');

const F = 'gsd-core/workflows/a.md';
const fixture = (t, files) => {
  const root = createTempDir('loop-phase-sites-');
  t.after(() => cleanup(root));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
};
const codes = (rows) => rows.map(({ file, code }) => [file, code]);
const joined = (text) => joinContinuations(splitLines(text)).map((l) => l.text).join('\n');

describe('render-hooks phase-site static check: counts, unlisted, dead-store', () => {
  const carries = 'X=$(gsd_run loop render-hooks plan:pre --raw --phase "$P")\n';
  const lacks = 'X=$(gsd_run loop render-hooks plan:pre --raw)\n';
  // The first capture group of `re` on `text`; a null match fails with the text, not a TypeError.
  const capture = (re, text) => {
    const m = re.exec(text);
    assert.notStrictEqual(m, null, `no match on ${JSON.stringify(text)}`);
    return m[1];
  };
  const onlyBare = (text, point) => {
    const { bare } = phaseSites.phaseSiteCounts(text, point);
    assert.strictEqual(bare.length, 1, `bare sites of ${JSON.stringify(text)}`);
    return bare[0][1];
  };

  // The runner reads `{file, line, message}`: a row names the SITES file it is about, not a prefix of its prose.
  test('run passes a typed row through: file, line and code of the violation', (t) => {
    const rows = phaseSites.run({ root: fixture(t, { [F]: carries }) });
    assert.ok(rows.length > 0, `run returned no rows: ${JSON.stringify(rows)}`);
    const [first] = rows;
    assert.deepStrictEqual({ file: first.file, line: first.line, code: first.code }, { file: phaseSites.SITES[0][0], line: 0, code: 'SITES_FILE_MISSING' });
  });

  test('run runs all four scans: removing any one of them from run drops a code', (t) => {
    const [file, point] = phaseSites.SITES[0];
    const call = `X=$(gsd_run loop render-hooks ${point} --raw --phase "$PHASE_NUMBER")`;
    const root = fixture(t, { [file]: `PHASE_NUMBER=1\nPHASE_NUMBER=2\n${call}\n${call}\n`, 'gsd-core/workflows/other.md': lacks });
    const found = new Set(phaseSites.run({ root }).map((r) => r.code));
    for (const code of ['SITE_COUNT', 'UNLISTED_SITE', 'DEAD_PHASE_STORE', 'FENCE_LINE']) assert.ok(found.has(code), `${code} missing from ${[...found]}`);
  });

  test('SITE_COUNT: a missing, an extra and a same-line duplicate call are each reported; a call without --phase still counts as a site (the fence scan reports its missing --phase)', (t) => {
    const sites = [[F, 'plan:pre', 1]];
    const countCodes = (text) => phaseSites.scanSiteCounts(fixture(t, { [F]: text }), sites).map((r) => r.code);
    assert.deepStrictEqual(countCodes(carries), []);
    assert.deepStrictEqual(countCodes(lacks), []);
    assert.deepStrictEqual(countCodes(''), ['SITE_COUNT']);
    assert.deepStrictEqual(countCodes(carries + lacks), ['SITE_COUNT']);
    assert.deepStrictEqual(countCodes(`${carries.trim()} ${lacks}`), ['SITE_COUNT']);
  });

  test('--active-cap: a call that carries it is no site of the counts or of the unlisted scan; the same call without it is one of each', (t) => {
    const cap = 'X=$(gsd_run loop render-hooks plan:pre --active-cap foo)\n';
    const plain = cap.replace(' --active-cap foo', ' --raw');
    assert.strictEqual(phaseSites.phaseSiteCounts(cap, 'plan:pre').bare.length, 0);
    assert.strictEqual(phaseSites.phaseSiteCounts(plain, 'plan:pre').bare.length, 1);
    assert.deepStrictEqual(phaseSites.scanUnlistedSites(fixture(t, { [F]: cap }), [], []), []);
    assert.deepStrictEqual(codes(phaseSites.scanUnlistedSites(fixture(t, { [F]: plain }), [], [])), [[F, 'UNLISTED_SITE']]);
  });

  test('SITES_FILE_MISSING, UNLISTED_SITE and STALE_SITE: a renamed or deleted SITES file is a row of the counts and the unlisted scan and a skip of the dead-store scan, never an ENOENT crash', (t) => {
    const root = fixture(t, { 'gsd-core/workflows/other.md': carries });
    const sites = [[F, 'plan:pre', 1]];
    assert.deepStrictEqual(codes(phaseSites.scanSiteCounts(root, sites)), [[F, 'SITES_FILE_MISSING']]);
    assert.deepStrictEqual(codes(phaseSites.scanUnlistedSites(root, sites, [])), [['gsd-core/workflows/other.md', 'UNLISTED_SITE'], [F, 'STALE_SITE']]);
    assert.deepStrictEqual(phaseSites.scanDeadPhaseStores(root, sites), []);
  });

  test('unlisted: a call site in a named row (SITES or phase-less) is no row; one in neither table is', (t) => {
    const root = fixture(t, { [F]: carries });
    assert.deepStrictEqual(phaseSites.scanUnlistedSites(root, [[F, 'plan:pre', 1]], []), []);
    assert.deepStrictEqual(phaseSites.scanUnlistedSites(root, [], [[F, 'plan:pre']]), []);
    assert.deepStrictEqual(codes(phaseSites.scanUnlistedSites(root, [], [])), [[F, 'UNLISTED_SITE']]);
    // every call of a logical line is a site: the second point of one line is found too
    const two = fixture(t, { [F]: `${carries.trim()}; ${lacks.replace('plan:pre', 'ship:pre')}` });
    assert.deepStrictEqual(codes(phaseSites.scanUnlistedSites(two, [[F, 'plan:pre', 1]], [])), [[F, 'UNLISTED_SITE']]);
    assert.deepStrictEqual(phaseSites.scanUnlistedSites(two, [[F, 'plan:pre', 1]], [[F, 'ship:pre']]), []);
    assert.deepStrictEqual(codes(phaseSites.scanUnlistedSites(root, [[F, 'plan:pre', 1], [F, 'plan:post', 1]], [])), [[F, 'STALE_SITE']]);
  });

  // A binding that a later binding in the same file overwrites before anything reads it is a
  // dead store and a wasted init query. The last binding is exempt: a Read-loaded step may consume it.
  test('DEAD_PHASE_STORE: a PHASE_NUMBER overwritten before it is read is reported, a read in between is not', (t) => {
    const sites = [[F, 'plan:pre', 1]];
    const scan = (text) => phaseSites.scanDeadPhaseStores(fixture(t, { [F]: text }), sites).map(({ file, line, code }) => ({ file, line, code }));
    assert.deepStrictEqual(scan('PHASE_NUMBER=1\nPHASE_NUMBER=2\n'), [{ file: F, line: 1, code: 'DEAD_PHASE_STORE' }]);
    assert.deepStrictEqual(scan('PHASE_NUMBER=1\necho "$PHASE_NUMBER"\nPHASE_NUMBER=2\n'), []);
    assert.deepStrictEqual(scan('PHASE_NUMBER=1\nPHASE_NUMBER=$PHASE_NUMBER\n'), []);
    // an agent-filled placeholder is no shell store: it neither flags the real store before it nor counts as one
    assert.deepStrictEqual(scan('PHASE_NUMBER=1\nPHASE_NUMBER="{phase_number}"\n'), []);
  });

  test('assignRe matches an export, a local and a bare assignment, and skips a placeholder and a longer name', () => {
    const re = phaseSites.assignRe('PHASE_NUMBER');
    for (const line of ['PHASE_NUMBER=1', '  export PHASE_NUMBER=1', 'local PHASE_NUMBER=$X']) assert.ok(re.test(line), line);
    for (const line of ['PHASE_NUMBER="{phase_number}"', 'PHASE_NUMBER_X=1', 'echo PHASE_NUMBER=1']) assert.ok(!re.test(line), line);
  });

  // The lint accepts a quoted point and a backslash-continued call; the counts and the scan must see both.
  test('[grammar] a quoted or line-wrapped render-hooks call counts as a bare site', () => {
    const quoted = 'X=$(gsd_run loop render-hooks "plan:pre" --raw)';
    const wrapped = 'X=$(gsd_run loop render-hooks \\\n  plan:pre --raw)';
    for (const text of [quoted, wrapped]) {
      const { withPhase } = phaseSites.phaseSiteCounts(text, 'plan:pre');
      onlyBare(text, 'plan:pre');
      assert.strictEqual(withPhase.length, 0, 'no --phase on it');
    }
    assert.strictEqual(phaseSites.phaseSiteCounts('X=$(gsd_run loop render-hooks plan:pre --raw --phase "$P")', 'plan:pre').withPhase.length, 1);
    // the quote is no part of the argument tail, so the e2e argv is built from the same text for both spellings
    assert.strictEqual(onlyBare(quoted, 'plan:pre'), ' --raw');
    // a wrapped call is judged at its first physical line
    assert.deepStrictEqual(phaseSites.callSites(['a', ...splitLines(wrapped)], 'plan:pre').map((s) => s.idx), [1]);
    // parity: the lint's regex (the same source as callRe) and the discovery regex accept the same spellings of `verify:post`
    for (const [text, accepted] of [
      ['loop render-hooks verify:post --raw', true],
      ['loop render-hooks "verify:post" --raw', true],
      ['loop render-hooks \\\n  verify:post --raw', true],
      ['loop render-hooks verify:pre --raw', false],
    ]) {
      assert.strictEqual(RENDER_HOOKS_VERIFY_POST_RE.test(joined(text)), accepted, `lint: ${text}`);
      assert.strictEqual(capture(phaseSites.CALL_POINT_RE, joined(text)), accepted ? 'verify:post' : 'verify:pre', `discovery: ${text}`);
    }
    // spellings of `verify:post` both regexes refuse: no space, an empty point, single quotes, no point at all, a leading colon, a capital
    for (const text of ['loop render-hooks"verify:post" --raw', 'loop render-hooks "" --raw', "loop render-hooks 'verify:post' --raw", 'loop render-hooks', 'loop render-hooks :verify:post --raw', 'loop render-hooks Verify:post --raw']) {
      assert.strictEqual(RENDER_HOOKS_VERIFY_POST_RE.test(joined(text)), false, `lint: ${text}`);
      assert.strictEqual(phaseSites.CALL_POINT_RE.exec(joined(text)), null, `discovery: ${text}`);
    }
    // malformed points only the discovery regex reads (the lint's regex is built for `verify:post`)
    for (const text of ['render-hooks plan: --raw', 'render-hooks plan::pre --raw', 'render-hooks ${} --raw', 'render-hooks ${P --raw', 'render-hooks :pre --raw', 'render-hooks Plan:pre --raw']) {
      assert.strictEqual(phaseSites.CALL_POINT_RE.exec(text), null, `discovery: ${text}`);
    }
    // a variable point is discovered as written, quoted or not; a `<point>` placeholder in prose is no call site
    assert.strictEqual(capture(phaseSites.CALL_POINT_RE, 'gsd_run loop render-hooks "${REVIEWER_POINT}" --raw'), '${REVIEWER_POINT}');
    assert.strictEqual(capture(phaseSites.CALL_POINT_RE, 'gsd_run loop render-hooks $P --raw'), '$P');
    assert.strictEqual(capture(phaseSites.CALL_POINT_RE, 'gsd_run loop render-hooks ${P} --raw'), '${P}');
    const placeholder = '`gsd_run loop render-hooks <point>`';
    assert.strictEqual(phaseSites.CALL_POINT_RE.exec(placeholder), null);
  });

  test('[grammar][property] any quoting, spacing and line join of one call is one bare site that discovery reads as the same point', () => {
    fc.assert(fc.property(
      fc.constantFrom('plan:pre', 'verify:post', 'execute:wave:post'),
      fc.constantFrom('', '"'),
      fc.constantFrom(' ', '  ', '\t', ' \\\n  '),
      (point, quote, gap) => {
        const text = `X=$(gsd_run loop render-hooks${gap}${quote}${point}${quote} --raw)`;
        assert.strictEqual(onlyBare(text, point), ' --raw', JSON.stringify(text));
        assert.strictEqual(capture(phaseSites.CALL_POINT_RE, joined(text)), point, JSON.stringify(text));
      },
    ), { seed: 4030, numRuns: 32 });
  });
});

describe('fences and phaseVarBinding (the one fence parser and the one binding walker)', () => {
  const lines = (...l) => splitLines(l.join('\n'));
  const call = 'X=$(gsd_run loop render-hooks plan:pre --raw --phase "${P}")';
  const ranges = (...l) => phaseSites.fences(lines(...l));

  test('fences: from the line after the opener to the closer; bash is exactly three backticks and an info word bash or sh', () => {
    assert.deepStrictEqual(ranges('```bash', 'a', '```'), [{ from: 1, to: 2, bash: true }]);
    assert.deepStrictEqual(ranges('  ```sh', 'a', '  ```'), [{ from: 1, to: 2, bash: true }]);
    assert.deepStrictEqual(ranges('```text', 'a', '```'), [{ from: 1, to: 2, bash: false }]);
    assert.deepStrictEqual(ranges('```', 'a', '```'), [{ from: 1, to: 2, bash: false }]);
    assert.deepStrictEqual(ranges('~~~bash', 'a', '~~~'), [{ from: 1, to: 2, bash: false }]);
    assert.deepStrictEqual(ranges('````bash', 'a', '````'), [{ from: 1, to: 2, bash: false }]);
    assert.deepStrictEqual(ranges('```bash title', 'a', '```'), [{ from: 1, to: 2, bash: true }]); // a second word of the info string
  });

  test('fences: a mark inside an open fence is content unless it closes it (same char, length at least the opener, no info string)', () => {
    assert.deepStrictEqual(ranges('```bash', '```bash', 'a', '```'), [{ from: 1, to: 3, bash: true }]);
    assert.deepStrictEqual(ranges('````text', '```bash', 'P=1', '```', '````'), [{ from: 1, to: 4, bash: false }]);
    assert.deepStrictEqual(ranges('~~~~', '~~~', '```', '~~~~'), [{ from: 1, to: 3, bash: false }]);
    assert.deepStrictEqual(ranges('~~~', '```bash', 'a', '```'), [{ from: 1, to: 4, bash: false }]);
    // one above the opener length still closes it
    assert.deepStrictEqual(ranges('````text', 'a', '`````'), [{ from: 1, to: 2, bash: false }]);
    assert.deepStrictEqual(ranges('~~~~', 'a', '~~~~~'), [{ from: 1, to: 2, bash: false }]);
  });

  test('fences: an unclosed fence runs to the end of the file', () => {
    assert.deepStrictEqual(ranges('```bash', 'a'), [{ from: 1, to: 2, bash: true }]);
  });

  test('fences: a backtick line with a backtick in its info string opens nothing', () => {
    assert.deepStrictEqual(ranges('```code``` text', 'a', '```bash', 'b', '```'), [{ from: 3, to: 4, bash: true }]);
  });

  test('accepts an assignment in a bash fence before the call', () => {
    assert.deepStrictEqual(phaseSites.phaseVarBinding(lines('```bash', 'P=$(echo 05)', call, '```'), 2, 'P'), { line: 1, sameFence: true });
  });
  test('rejects a call with no assignment anywhere, one after the call, one outside a bash fence and a placeholder', () => {
    for (const [l, idx] of [
      [lines('```bash', call, '```'), 1],
      [lines('```bash', call, 'P=05', '```'), 1],
      [lines('P=05', '```bash', call, '```'), 2],
      [lines('```bash', 'P="{phase_number}"', call, '```'), 2],
      [lines('~~~bash', 'P=05', call, '~~~'), 2],
      [lines('````text', '```bash', 'P=05', '```', call, '````'), 4],
    ]) assert.strictEqual(phaseSites.phaseVarBinding(l, idx, 'P').line, -1, l.join('\n'));
  });
  test('reports an assignment in an earlier fence as cross-fence', () => {
    assert.deepStrictEqual(phaseSites.phaseVarBinding(lines('```bash', 'P=05', '```', 'prose', '```bash', call, '```'), 5, 'P'), { line: 1, sameFence: false });
  });
});

describe('render-hooks fence scan (scanSiteFences)', () => {
  const WS = phaseSites.WS_EXPANSION;
  const call = `X=$(gsd_run loop render-hooks plan:pre --raw --phase "\${PHASE_NUMBER}" ${WS})`;
  const CAPTURE = [phaseSites.GSD_ARGS_CAPTURE, '$ARGUMENTS', 'GSD_ARGS_END'];
  const TRIM = phaseSites.GSD_ARGS_TRIM;
  const ws = phaseSites.GSD_WS_LINE;
  const bind = [...phaseSites.ARGS_BIND, `PHASE_NUMBER=$(gsd_run query init.phase-op ${WS} "\${1}" --pick phase_number)`];
  const raw = (...body) => ['```bash', ...body, '```', ''].join('\n');
  const fence = (...body) => raw(...CAPTURE, TRIM, ...body);
  const codesOf = (t, text, { file = F, point = 'plan:pre', pins = {} } = {}) =>
    phaseSites.scanSiteFences(fixture(t, { [file]: text }), [[file, point, 1]], pins).map((r) => r.code);

  test('a call whose fence captures its args, derives GSD_WS and binds its phase in place has no row, in any fence spelling the parser reads', (t) => {
    const good = fence(ws, ...bind, call);
    assert.deepStrictEqual(codesOf(t, good), []);
    assert.deepStrictEqual(codesOf(t, good.replace(/^/gm, '   ')), [], 'a list-indented fence');
    assert.deepStrictEqual(codesOf(t, good.split('\n').join('\r\n')), [], 'CRLF');
    assert.deepStrictEqual(codesOf(t, good.slice(0, good.lastIndexOf('```'))), [], 'a fence that never closes');
  });

  test('phaseVarOf: one owner of the quoted phase variable, balanced braces only; withPhase counts through it', () => {
    for (const [tail, name] of [[' --phase "$P"', 'P'], [' --phase "${P}"', 'P'], [' --raw', null], [' --phase 05', null], [' --phase "${P"', null], [' --phase "$P}"', null], [' --phase ""', null], [' --phase "$"', null], [' --phase "${}"', null]]) {
      assert.strictEqual(phaseSites.phaseVarOf(tail), name, tail);
    }
    assert.strictEqual(phaseSites.phaseSiteCounts('x render-hooks plan:pre --raw --phase "${P"', 'plan:pre').withPhase.length, 0);
  });

  test('PHASE_ARG: --phase takes one quoted variable with balanced braces', (t) => {
    const withArg = (arg) => fence(ws, ...bind, call.replace('"${PHASE_NUMBER}"', arg));
    assert.deepStrictEqual(codesOf(t, withArg('"$PHASE_NUMBER"')), []);
    for (const bad of ['05', '"${PHASE_NUMBER"', '"$PHASE_NUMBER}"', '$PHASE_NUMBER', '""', '"$"', '"${}"']) assert.deepStrictEqual(codesOf(t, withArg(bad)), ['PHASE_ARG'], bad);
    assert.deepStrictEqual(codesOf(t, fence(ws, ...bind, call.replace(' --phase "${PHASE_NUMBER}"', ''))), ['PHASE_ARG']);
  });

  test('WS_EXPANSION: the call forwards the workstream', (t) => {
    assert.deepStrictEqual(codesOf(t, fence(ws, ...bind, call.replace(WS, ''))), ['WS_EXPANSION']);
  });

  test('FENCE_LINE: each pinned line is required, once, in order, in the call\'s own fence', (t) => {
    const weakWs = ws.replace(/\["'\\''\]\?/, '');
    assert.notStrictEqual(weakWs, ws);
    const fail = (text) => assert.deepStrictEqual(codesOf(t, text), ['FENCE_LINE'], text);
    fail(raw(TRIM, ws, ...bind, call)); // no capture
    fail(raw(...CAPTURE, ws, ...bind, call)); // no trim
    fail(fence(...bind, call)); // no derive
    fail(fence(weakWs, ...bind, call)); // a weaker derive
    fail(fence(`${ws} # a comment`, ...bind, call)); // a suffix on the derive
    fail(fence(`${ws}; GSD_WS=`, ...bind, call));
    fail(raw(CAPTURE[0].replace("'GSD_ARGS_END'", 'GSD_ARGS_END'), '$ARGUMENTS', 'GSD_ARGS_END', TRIM, ws, ...bind, call)); // unquoted heredoc
    fail(raw(`# ${CAPTURE[0]}`, '$ARGUMENTS', 'GSD_ARGS_END', TRIM, ws, ...bind, call)); // commented capture
    fail(raw(...CAPTURE, ws, TRIM, ...bind, call)); // capture, derive, trim
    fail(raw(TRIM, ...CAPTURE, ws, ...bind, call)); // trim, capture
    fail(raw(...CAPTURE, TRIM, ...bind.slice(0, 2), ws, bind[2], call)); // derive after the ARGS_BIND
    fail(fence(ws, bind[2], call)); // no ARGS_BIND
    fail(fence(ws, bind[0], bind[1], 'shift', bind[2], call)); // a line between ARGS_BIND and the bind
    fail(fence(...bind, call, ws)); // GSD_WS read before the fence assigns it
    fail(fence(ws, ...bind, call, 'GSD_WS=other')); // a rebind after the call
    fail(fence(ws, 'GSD_ARGS=other', ...bind, call));
    fail(raw(...CAPTURE, TRIM, ...CAPTURE, ws, ...bind, call)); // a second capture
    fail(`${fence()}${raw(ws, ...bind, call)}`); // the prelude sits in another fence
    assert.deepStrictEqual(codesOf(t, [call, ''].join('\n')), ['PHASE_BIND', 'FENCE_LINE']); // the call sits in no fence at all
  });

  test('FENCE_LINE: the #4772 note is required in the fence of a Read-loaded file only', (t) => {
    const G = 'gsd-core/workflows/x/steps/b.md';
    assert.deepStrictEqual(codesOf(t, fence(ws, ...bind, call), { file: G }), ['FENCE_LINE']);
    assert.deepStrictEqual(codesOf(t, fence(phaseSites.READ_LOADED_NOTE, ws, ...bind, call), { file: G }), []);
  });

  test('a fence the parser does not read as bash binds nothing: ~~~, four backticks and a non-bash info string fail closed', (t) => {
    const body = [...CAPTURE, TRIM, ws, ...bind, call];
    const spell = (open, close) => [open, ...body, close, ''].join('\n');
    assert.deepStrictEqual(codesOf(t, spell('```bash', '```')), []);
    for (const [open, close] of [['~~~bash', '~~~'], ['````bash', '````'], ['```text', '```']]) {
      assert.deepStrictEqual(codesOf(t, spell(open, close)), ['PHASE_BIND', 'FENCE_LINE'], open);
    }
  });

  test('PHASE_BIND: the last assignment before the call, in the call\'s own fence, is one of OWN_BINDS', (t) => {
    const fail = (text) => assert.deepStrictEqual(codesOf(t, text), ['PHASE_BIND'], text);
    fail(fence(ws, call)); // never assigned
    fail(fence(ws, 'PHASE_NUMBER=5', call)); // an unknown bind
    fail(fence(ws, ...bind, 'PHASE_NUMBER=5', call)); // a later assignment wins
    fail(`${fence(...bind)}${fence(ws, call)}`); // bound in an earlier fence: each fence is its own shell
  });

  test('a workflow line echoed into a row message is escaped: a control byte never reaches the report', (t) => {
    const echoed = (text) => {
      const rows = phaseSites.scanSiteFences(fixture(t, { [F]: text }), [[F, 'plan:pre', 1]], {});
      assert.ok(rows.length > 0, `scan returned no rows: ${JSON.stringify(rows)}`);
      return rows[0].echoed;
    };
    assert.strictEqual(echoed(fence(ws, 'PHASE_NUMBER=5', call)), '"PHASE_NUMBER=5"');
    assert.ok(!echoed(fence(ws, 'PHASE_NUMBER=\u001b[31m5', call)).includes('\u001b'));
  });

  test('HOST_BOUND: a host-bound site passes the host variable and shell-assigns nothing', (t) => {
    const opts = { file: 'gsd-core/workflows/autonomous.md', point: 'execute:post' };
    const hostCall = (v) => `X=$(gsd_run loop render-hooks execute:post --raw --phase "\${${v}}" ${WS})`;
    assert.deepStrictEqual(codesOf(t, fence(ws, hostCall('PHASE_NUM')), opts), []);
    assert.deepStrictEqual(codesOf(t, fence(ws, hostCall('PHASE_NUMBER')), opts), ['HOST_BOUND']);
    assert.deepStrictEqual(codesOf(t, fence(ws, 'PHASE_NUM=5', hostCall('PHASE_NUM')), opts), ['HOST_BOUND']);
  });

  // Fixture provenance (CONTRIBUTING.md #2371): the fence of gsd-core/workflows/discuss-phase.md :: discuss:pre as
  // shipped, copied byte for byte into tests/fixtures/render-hooks-phase-sites/ (a fixture, not a read of the
  // workflow: ADR-456, ADR-6315). Its lines are the fixtures; the mutators below are generic.
  const SHIPPED = 'gsd-core/workflows/discuss-phase.md';
  // Read inside each test: a missing fixture fails that test, never the registration of the file's tests.
  const shippedFence = () => splitLines(fs.readFileSync(path.join(__dirname, 'fixtures', 'render-hooks-phase-sites', 'discuss-pre-fence.sh'), 'utf8')).filter((l) => l !== '');
  const scanShipped = (t, body) => phaseSites.scanSiteFences(fixture(t, { [SHIPPED]: raw(...body) }), [[SHIPPED, 'discuss:pre', 1]], {}).map((r) => r.code);

  test('fixture provenance: the helper fences are lines of the shipped fence, which passes alone', (t) => {
    const shipped = shippedFence();
    for (const l of [...CAPTURE, TRIM, ws, ...bind.slice(0, -1)]) assert.ok(shipped.includes(l), `not a shipped line: ${l}`);
    assert.deepStrictEqual(scanShipped(t, shipped), []);
  });

  test('every deletion, adjacent swap and suffix of a shipped pre-call line is a row', (t) => {
    const shipped = shippedFence();
    const call = shipped.findIndex((l) => phaseSites.CALL_POINT_RE.test(l));
    assert.ok(call > 0, `no call line after the pinned lines in the fixture: ${JSON.stringify(shipped)}`);
    for (let i = 0; i < call; i++) {
      const mutants = {
        delete: shipped.filter((_, j) => j !== i),
        suffix: shipped.map((l, j) => (j === i ? `${l} x` : l)),
        swap: shipped.map((l, j) => (j === i ? shipped[i + 1] : j === i + 1 ? shipped[i] : l)),
      };
      for (const [kind, mutant] of Object.entries(mutants)) assert.notDeepStrictEqual(scanShipped(t, mutant), [], `${kind} of line ${i}: ${shipped[i]}`);
    }
  });

  test('the ${PHASE} bind of plan-phase reads PHASE from its pinned earlier fence: accepted, CARRY when that line changes, PIN_STALE when nothing reads it', (t) => {
    const PP = 'gsd-core/workflows/plan-phase.md';
    const phaseBind = `PHASE_NUMBER=\${PHASE_NUMBER:-$(gsd_run query init.phase-op ${WS} "\${PHASE}" --pick phase_number)}`;
    // the default pins; a pin of another site is no row of this one
    const scan = (text) => phaseSites.scanSiteFences(fixture(t, { [PP]: text }), [[PP, 'plan:pre', 1]])
      .filter((r) => r.code !== 'PIN_STALE' || r.site === `${PP} :: plan:pre`).map((r) => r.code);
    const fromPhase = (earlier) => `${raw(earlier)}${fence(ws, phaseBind, call)}`;
    assert.deepStrictEqual(scan(fromPhase('PHASE="${BASH_REMATCH[1]}"')), []);
    assert.deepStrictEqual(scan(fromPhase('PHASE=7')), ['CARRY']);
    assert.deepStrictEqual(scan(fence(ws, phaseBind, call)), ['PIN_STALE']);
  });

  test('CARRY and PIN_STALE: a source variable a bind reads from another fence must be pinned, unchanged and in use', (t) => {
    const VW = 'gsd-core/workflows/verify-work.md';
    const key = `${VW} :: verify:post`;
    const pins = { [key]: phaseSites.VERIFY_WORK_INIT };
    const post = call.replace('plan:pre', 'verify:post');
    const fromInit = (earlier) => `${raw(earlier)}${fence(ws, 'PHASE_NUMBER=$(printf \'%s\' "$INIT" | jq -r \'.phase_number // empty\')', post)}`;
    const opts = { file: VW, point: 'verify:post', pins };
    assert.deepStrictEqual(codesOf(t, fromInit(phaseSites.VERIFY_WORK_INIT), opts), []);
    assert.deepStrictEqual(codesOf(t, fromInit('INIT=$(something else)'), opts), ['CARRY']);
    assert.deepStrictEqual(codesOf(t, fromInit('INIT=1'), { ...opts, pins: {} }), ['CARRY']);
    // the earlier-fence line a CARRY row quotes is escaped: a control byte never reaches the report
    const rows = phaseSites.scanSiteFences(fixture(t, { [VW]: fromInit('INIT=\u001b[31m1') }), [[VW, 'verify:post', 1]], pins);
    assert.ok(rows.length > 0, `scan returned no rows: ${JSON.stringify(rows)}`);
    const [changed] = rows;
    assert.strictEqual(changed.code, 'CARRY');
    assert.ok(!changed.echoed.includes('\u001b'), JSON.stringify(changed.echoed));
    // a pin that no visited row uses, and a key that names no SITES row, are table rows
    assert.deepStrictEqual(codesOf(t, fence(ws, ...bind, post), opts), ['PIN_STALE']);
    assert.deepStrictEqual(phaseSites.scanSiteFences(fixture(t, {}), [], { [key]: 'x' }).map((r) => r.code), ['PIN_STALE']);
  });
});
