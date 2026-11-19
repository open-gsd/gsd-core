"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestStatus = exports.ReportFormat = void 0;
exports.parseTestReport = parseTestReport;
/** Format adapters for RED evidence. Parsing never depends on the runner command. */
const tap_parser_cjs_1 = require("./vendor/tap-parser.cjs");
const saxes_cjs_1 = require("./vendor/saxes.cjs");
exports.ReportFormat = {
    Tap: 'tap', Junit: 'junit', SwiftTesting: 'swift-testing', Unittest: 'unittest', GoTest: 'go-test', Unknown: 'unknown',
};
exports.TestStatus = { Passed: 'passed', Failed: 'failed', Skipped: 'skipped', Todo: 'todo' };
/**
 * A name that is a JS/TS test source file, as opposed to a Java class or method. Limited to the
 * extensions vitest, jest and node:test load: a wider list (`go`, `rs`, `py`, ...) would flag a
 * Surefire class-level entry whose FQN ends in that segment (`com.acme.go`, #4724).
 */
const TEST_FILE_NAME = /\.[cm]?[jt]sx?$/;
/** jest-junit's classNameTemplate for a suite that produced no results (utils/buildJsonResults.js). */
const JEST_SUITE_FAILED_TO_RUN = 'Test suite failed to run';
function parseTap(output) {
    const report = { format: exports.ReportFormat.Tap, valid: true, tests: [], issues: [] };
    const parser = new tap_parser_cjs_1.Parser({ strict: true });
    const assertions = [];
    const openBuffered = new Map();
    let completed = false;
    const watch = (p) => {
        p.on('child', (child) => {
            if (child.buffered)
                openBuffered.set(p, (openBuffered.get(p) ?? 0) + 1);
            watch(child);
        });
        // tap-parser finalizes buffered children at EOF even without their closing
        // brace. Track its child/line events so that truncation cannot prove RED.
        p.on('line', (line) => {
            if (line === '}\n')
                openBuffered.set(p, (openBuffered.get(p) ?? 0) - 1);
        });
        p.on('assert', (result) => {
            if (!result.closingTestPoint)
                assertions.push({ result, owner: p });
            if (result.buffered && !result.closingTestPoint)
                report.issues.push('Missing buffered TAP subtest');
            const diag = result.diag;
            if (diag && ['cancelledByParent', 'hookFailed', 'testTimeoutFailure'].includes(String(diag['failureType']))) {
                report.issues.push('Test run interrupted by cancellation, hook failure, or timeout');
            }
        });
        p.on('extra', (extra) => { if (extra.trim())
            report.issues.push('Non-TAP data in report'); });
        p.on('complete', (summary) => {
            if (p === parser)
                completed = true;
            const { start, end } = summary.plan;
            if (start !== 1 || end === null || summary.count !== end)
                report.issues.push('Missing or incomplete TAP plan');
            if (summary.bailout)
                report.issues.push('TAP bailout');
            if (summary.failures.some((failure) => failure.tapError))
                report.issues.push('Malformed TAP');
        });
    };
    watch(parser);
    parser.end(output);
    if ([...openBuffered.values()].some((count) => count !== 0))
        report.issues.push('Unclosed buffered TAP subtest');
    for (const { result, owner } of assertions) {
        let skipped = Boolean(result.skip);
        let todo = Boolean(result.todo);
        for (let parent = owner; parent; parent = parent.parent) {
            skipped ||= Boolean(parent.closingTestPoint?.skip);
            todo ||= Boolean(parent.closingTestPoint?.todo);
        }
        // node:test reports a file that exits non-zero without a failing subtest as `not ok N - <file>`
        // with `error: 'test failed'` / `code: 'ERR_TEST_FAILURE'` (#5721): it asserted nothing.
        const diag = result.diag;
        const fileFailure = !result.ok && diag?.['error'] === 'test failed' && diag['code'] === 'ERR_TEST_FAILURE'
            && TEST_FILE_NAME.test(result.name);
        report.tests.push({
            name: result.name,
            identities: [...new Set([result.name, result.fullname])],
            group: null,
            groupIdentities: [],
            status: skipped ? exports.TestStatus.Skipped : todo ? exports.TestStatus.Todo : result.ok ? exports.TestStatus.Passed : exports.TestStatus.Failed,
            ...(fileFailure ? { loadFailure: true } : {}),
        });
    }
    if (!completed)
        report.issues.push('Incomplete TAP stream');
    report.valid = report.issues.length === 0;
    return report;
}
/** Surefire and Failsafe share the JUnit XML report shape. */
function parseJunit(output) {
    const report = { format: exports.ReportFormat.Junit, valid: true, tests: [], issues: [] };
    const parser = new saxes_cjs_1.SaxesParser({ xmlns: false });
    const elements = [];
    const suites = [];
    let current = null;
    parser.on('error', () => { report.issues.push('Malformed XML'); });
    parser.on('doctype', () => { report.issues.push('JUnit reports must not declare a DTD'); });
    parser.on('opentag', (tag) => {
        const parent = elements.at(-1);
        if (!parent && tag.name !== 'testsuite' && tag.name !== 'testsuites')
            report.issues.push('Not a JUnit report');
        if (tag.name === 'testsuite' || tag.name === 'testsuites') {
            if (parent && parent !== 'testsuite' && parent !== 'testsuites')
                report.issues.push('Misplaced test suite');
            const count = tag.attributes['tests'];
            const planned = count === undefined ? null : Number(count);
            if (count !== undefined && (!/^\d+$/.test(count) || !Number.isSafeInteger(planned)))
                report.issues.push('Invalid JUnit test count');
            suites.push({ firstTest: report.tests.length, planned });
        }
        else if (tag.name === 'testcase') {
            if (parent !== 'testsuite' || current)
                report.issues.push('Misplaced test case');
            const name = tag.attributes['name'] ?? '';
            const className = tag.attributes['classname'] ?? '';
            const qualified = className ? `${className}#${name}` : name;
            if (!name)
                report.issues.push('Unnamed test case');
            current = {
                name: qualified,
                identities: [...new Set([name, qualified])],
                group: className || null,
                groupIdentities: className ? [className, className.split('.').at(-1)] : [],
                status: exports.TestStatus.Passed,
                ...(className === JEST_SUITE_FAILED_TO_RUN || (name === className && TEST_FILE_NAME.test(name))
                    ? { loadFailure: true } : {}),
            };
        }
        else if (current && parent === 'testcase') {
            if (tag.name === 'failure' || tag.name === 'error') {
                if (current.status === exports.TestStatus.Skipped)
                    report.issues.push('Contradictory JUnit status');
                current.status = exports.TestStatus.Failed;
            }
            if (tag.name === 'skipped') {
                if (current.status === exports.TestStatus.Failed)
                    report.issues.push('Contradictory JUnit status');
                current.status = exports.TestStatus.Skipped;
            }
        }
        elements.push(tag.name);
    });
    parser.on('closetag', (tag) => {
        if (tag.name === 'testcase' && current) {
            report.tests.push(current);
            current = null;
        }
        else if (tag.name === 'testsuite' || tag.name === 'testsuites') {
            const suite = suites.pop();
            if (!suite || (suite.planned !== null && suite.planned !== report.tests.length - suite.firstTest)) {
                report.issues.push('Incomplete JUnit test suite');
            }
        }
        elements.pop();
    });
    parser.write(output).close();
    report.valid = report.issues.length === 0;
    return report;
}
/**
 * swift-testing console output (#4957). Only the anchored aggregate line marks
 * the format; every declared test must have its own result line. The aggregate
 * counts skipped tests too, and a parameterized test names its case count.
 * A test is named by its quoted display name (with `(aka 'function()')` under
 * --verbose) or, without one, by its bare function name. Windows consoles
 * print √ × - in place of ✔ ✘ ━. swift-testing 6.1 omits the suite count from
 * the aggregate and marks skipped tests with ✘ (later sources add the count
 * and use ➜).
 */
const SWIFT_AGGREGATE = /^[ \t]*[✘✔━×√-][ \t]*Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed)\b/gm;
const SWIFT_RESULT = /^[ \t]*[✘✔━➜×√-][ \t]*Test (?:"([^"]+)"(?: \(aka '([^']+)'\))?|([^\s"]\S*\)))(?: with \d+ test cases?)? (?:(failed|passed|was cancelled) after [\d.]+ seconds?(?: with \d+ [^\n]*?)?(?:\.|: "[^\n]*")|(skipped)(?:\.|: "[^\n]*"))$/gm;
function parseSwiftTesting(output) {
    const report = { format: exports.ReportFormat.SwiftTesting, valid: true, tests: [], issues: [] };
    let declared = 0;
    let runPassed = true;
    for (const match of output.matchAll(SWIFT_AGGREGATE)) {
        declared += Number(match[1]);
        runPassed &&= match[2] === 'passed';
    }
    for (const match of output.matchAll(SWIFT_RESULT)) {
        const fn = match[2] ?? match[3];
        report.tests.push({
            name: match[1] ?? match[3],
            identities: [...new Set([match[1], fn, fn?.replace(/\(.*\)$/, '')].filter((id) => Boolean(id)))],
            group: null,
            groupIdentities: [],
            status: match[4] === 'failed' ? exports.TestStatus.Failed : match[4] === 'passed' ? exports.TestStatus.Passed : exports.TestStatus.Skipped,
        });
    }
    if (report.tests.length !== declared)
        report.issues.push('Incomplete swift-testing report');
    if (runPassed && report.tests.some((test) => test.status === exports.TestStatus.Failed)) {
        report.issues.push('Contradictory swift-testing status');
    }
    report.valid = report.issues.length === 0;
    return report;
}
/**
 * Python stdlib unittest text output (#4970). Passing tests are unnamed unless
 * verbose, so they are counted from the summary; failures are named by their
 * FAIL:/ERROR: headers, which must account for every counted failure. Each
 * failing subTest repeats its method's header and counts as a failure, while
 * Ran counts methods, so identical headers collapse into one failed test. An
 * unexpected success fails the run but is a test that passed.
 */
const UNITTEST_RAN = /^Ran (\d+) tests? in [\d.]+s$/gm;
const UNITTEST_HEADER = /^(?:FAIL|ERROR): (\S+)(?: \(([^)]*)\))?/gm;
function parseUnittest(output) {
    const report = { format: exports.ReportFormat.Unittest, valid: true, tests: [], issues: [] };
    const runs = [...output.matchAll(UNITTEST_RAN)];
    if (runs.length !== 1) {
        report.issues.push('Expected exactly one unittest summary');
        report.valid = false;
        return report;
    }
    const ran = Number(runs[0][1]);
    const outcome = /^(OK|FAILED)(?: \(([^)]*)\))?$/m.exec(output.slice(runs[0].index + runs[0][0].length));
    const counts = {};
    for (const part of outcome?.[2]?.split(', ') ?? []) {
        const [key, value] = part.split('=');
        counts[key] = Number(value);
    }
    if (!outcome || Object.keys(counts).some((key) => !['failures', 'errors', 'skipped', 'expected failures', 'unexpected successes'].includes(key))) {
        report.issues.push('Unsupported unittest outcome');
    }
    let headers = 0;
    const failedIds = new Set();
    for (const match of output.matchAll(UNITTEST_HEADER)) {
        headers++;
        const id = match[2] ?? '';
        const key = `${match[1]} ${id}`;
        if (failedIds.has(key))
            continue;
        failedIds.add(key);
        // unittest synthesizes _FailedTest for an import/collection crash; its
        // method name can equal the target, so it is a load failure, never RED.
        if (id.includes('_FailedTest')) {
            report.issues.push('unittest module failed to load');
            continue;
        }
        report.tests.push({
            name: match[1],
            identities: [...new Set([match[1], id].filter(Boolean))],
            group: null,
            groupIdentities: [],
            status: exports.TestStatus.Failed,
        });
    }
    const failed = (counts['failures'] ?? 0) + (counts['errors'] ?? 0);
    const skipped = counts['skipped'] ?? 0;
    const runFailed = failed > 0 || (counts['unexpected successes'] ?? 0) > 0;
    if (headers !== failed || (outcome?.[1] === 'FAILED') !== runFailed || failedIds.size + skipped > ran) {
        report.issues.push('Incomplete unittest report');
    }
    const unnamed = (status) => ({ name: '', identities: [], group: null, groupIdentities: [], status });
    for (let i = 0; i < skipped; i++)
        report.tests.push(unnamed(exports.TestStatus.Skipped));
    for (let i = Math.max(ran - failedIds.size - skipped, 0); i > 0; i--)
        report.tests.push(unnamed(exports.TestStatus.Passed));
    report.valid = report.issues.length === 0;
    return report;
}
/**
 * `go test` text output (#5106). Plain console text, so the shape is matched by line:
 *   --- FAIL: TestName (0.00s)          one per failed test (every test with -v; subtests indented)
 *   FAIL\texample.com/pkg\t0.004s        one package summary per package, after that package's tests
 *   FAIL\texample.com/pkg [build failed]   the package did not compile — nothing asserted anything
 * A test's name carries no package, so each test is also known as `<package>.<name>`, attributed to
 * the next package summary line. The same name failing in two packages is ambiguous until qualified.
 * `go test -json` is not text and stays unsupported.
 */
const GO_TEST_RESULT = /^[ \t]*-{3} (PASS|FAIL|SKIP): (\S+) \(\d+(?:\.\d+)?s\)$/; // -{3}: not a literal fence, see frontmatter-fence-drift
const GO_PACKAGE_LINE = /^(ok|FAIL|\?)[ \t]+(\S+)[ \t]+(?:\d+(?:\.\d+)?s\b|\(cached\)|\[([a-z ]+)\])/;
function isGoTestOutput(output) {
    if (/^TAP version \d+/.test(output.trimStart()))
        return false;
    return output.split(/\r?\n/).some((line) => GO_TEST_RESULT.test(line) || GO_PACKAGE_LINE.test(line));
}
function parseGoTest(output) {
    const report = { format: exports.ReportFormat.GoTest, valid: true, tests: [], issues: [] };
    let segment = [];
    let packages = 0;
    for (const line of output.split(/\r?\n/)) {
        const result = GO_TEST_RESULT.exec(line);
        if (result) {
            const name = result[2];
            const status = result[1] === 'FAIL' ? exports.TestStatus.Failed : result[1] === 'SKIP' ? exports.TestStatus.Skipped : exports.TestStatus.Passed;
            if (!segment.some((test) => test.name === name && test.status === status)) {
                segment.push({ name, identities: [name], group: null, groupIdentities: [], status });
            }
            continue;
        }
        const pkg = GO_PACKAGE_LINE.exec(line);
        if (!pkg)
            continue;
        packages++;
        const [, outcome, importPath, bracket] = pkg;
        if (outcome === 'FAIL' && (bracket === 'build failed' || bracket === 'setup failed')) {
            report.buildFailed = true;
            report.issues.push(`go test package ${importPath} ${bracket}`);
        }
        else if (outcome === 'ok' && segment.some((test) => test.status === exports.TestStatus.Failed)) {
            report.issues.push(`go test package ${importPath} is ok but its output reports a failed test`);
        }
        for (const test of segment)
            test.identities.push(`${importPath}.${test.name}`);
        report.tests.push(...segment);
        segment = [];
    }
    if (packages === 0)
        report.issues.push('Missing go test package summary');
    if (segment.length > 0)
        report.issues.push('go test results without a following package summary');
    report.valid = report.issues.length === 0;
    return report;
}
const adapters = [
    // Before TAP: a run whose first package is fine begins `ok  <TAB>pkg`, which the TAP matcher reads as a point.
    { matches: isGoTestOutput, parse: parseGoTest },
    { matches: (output) => /^(?:TAP version \d+|(?:not )?ok\b|1\.\.\d+|#)/.test(output.trimStart()), parse: parseTap },
    { matches: (output) => output.trimStart().startsWith('<'), parse: parseJunit },
    { matches: (output) => new RegExp(SWIFT_AGGREGATE.source, 'm').test(output), parse: parseSwiftTesting },
    { matches: (output) => new RegExp(UNITTEST_RAN.source, 'm').test(output), parse: parseUnittest },
];
/** Parse supported reports into one result contract; unknown/malformed input fails closed. */
function parseTestReport(output) {
    const adapter = adapters.find((candidate) => candidate.matches(output));
    if (!adapter)
        return { format: exports.ReportFormat.Unknown, valid: false, tests: [], issues: ['Unsupported report format'] };
    try {
        const report = adapter.parse(output);
        // One entry per problem: a long run of bad lines must not amplify the payload.
        return { ...report, issues: [...new Set(report.issues)] };
    }
    catch {
        return { format: exports.ReportFormat.Unknown, valid: false, tests: [], issues: ['Malformed report'] };
    }
}
