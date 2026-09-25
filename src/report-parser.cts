/** Format adapters for RED evidence. Parsing never depends on the runner command. */
import { Parser, type FinalResults, type Result } from './vendor/tap-parser.cjs';
import { SaxesParser } from './vendor/saxes.cjs';

export const ReportFormat = { Tap: 'tap', Junit: 'junit', Unknown: 'unknown' } as const;
export type ReportFormat = (typeof ReportFormat)[keyof typeof ReportFormat];
export const TestStatus = { Passed: 'passed', Failed: 'failed', Skipped: 'skipped', Todo: 'todo' } as const;
export type TestStatus = (typeof TestStatus)[keyof typeof TestStatus];

export interface TestReportCase {
  /** Display name retained in the existing evidence payload. */
  name: string;
  /** Accepted identities, including the qualified suite/class name. */
  identities: string[];
  /** A class can name a group of methods; empty for individual TAP tests. */
  group: string | null;
  groupIdentities: string[];
  status: TestStatus;
}

export interface TestReport {
  format: ReportFormat;
  /** False means the entire report is unusable, even if some tests parsed. */
  valid: boolean;
  tests: TestReportCase[];
  issues: string[];
}

interface TestReportAdapter {
  matches(output: string): boolean;
  parse(output: string): TestReport;
}

function parseTap(output: string): TestReport {
  const report: TestReport = { format: ReportFormat.Tap, valid: true, tests: [], issues: [] };
  const parser = new Parser({ strict: true });
  const assertions: { result: Result; owner: Parser }[] = [];
  const openBuffered = new Map<Parser, number>();
  let completed = false;
  const watch = (p: Parser): void => {
    p.on('child', (child: Parser) => {
      if (child.buffered) openBuffered.set(p, (openBuffered.get(p) ?? 0) + 1);
      watch(child);
    });
    // tap-parser finalizes buffered children at EOF even without their closing
    // brace. Track its child/line events so that truncation cannot prove RED.
    p.on('line', (line: string) => {
      if (line === '}\n') openBuffered.set(p, (openBuffered.get(p) ?? 0) - 1);
    });
    p.on('assert', (result: Result) => {
      if (!result.closingTestPoint) assertions.push({ result, owner: p });
      if (result.buffered && !result.closingTestPoint) report.issues.push('Missing buffered TAP subtest');
      const diag = result.diag as Record<string, unknown> | null;
      if (diag && ['cancelledByParent', 'hookFailed', 'testTimeoutFailure'].includes(String(diag['failureType']))) {
        report.issues.push('Test run interrupted by cancellation, hook failure, or timeout');
      }
    });
    p.on('extra', (extra: string) => { if (extra.trim()) report.issues.push('Non-TAP data in report'); });
    p.on('complete', (summary: FinalResults) => {
      if (p === parser) completed = true;
      const { start, end } = summary.plan;
      if (start !== 1 || end === null || summary.count !== end) report.issues.push('Missing or incomplete TAP plan');
      if (summary.bailout) report.issues.push('TAP bailout');
      if (summary.failures.some((failure) => failure.tapError)) report.issues.push('Malformed TAP');
    });
  };
  watch(parser);
  parser.end(output);
  if ([...openBuffered.values()].some((count) => count !== 0)) report.issues.push('Unclosed buffered TAP subtest');
  for (const { result, owner } of assertions) {
    let skipped = Boolean(result.skip);
    let todo = Boolean(result.todo);
    for (let parent: Parser | null = owner; parent; parent = parent.parent) {
      skipped ||= Boolean(parent.closingTestPoint?.skip);
      todo ||= Boolean(parent.closingTestPoint?.todo);
    }
    report.tests.push({
      name: result.name,
      identities: [...new Set([result.name, result.fullname])],
      group: null,
      groupIdentities: [],
      status: skipped ? TestStatus.Skipped : todo ? TestStatus.Todo : result.ok ? TestStatus.Passed : TestStatus.Failed,
    });
  }
  if (!completed) report.issues.push('Incomplete TAP stream');
  report.valid = report.issues.length === 0;
  return report;
}

/** Surefire and Failsafe share the JUnit XML report shape. */
function parseJunit(output: string): TestReport {
  const report: TestReport = { format: ReportFormat.Junit, valid: true, tests: [], issues: [] };
  const parser = new SaxesParser({ xmlns: false });
  const elements: string[] = [];
  const suites: { firstTest: number; planned: number | null }[] = [];
  let current: TestReportCase | null = null;
  parser.on('error', () => { report.issues.push('Malformed XML'); });
  parser.on('doctype', () => { report.issues.push('JUnit reports must not declare a DTD'); });
  parser.on('opentag', (tag) => {
    const parent = elements.at(-1);
    if (!parent && tag.name !== 'testsuite' && tag.name !== 'testsuites') report.issues.push('Not a JUnit report');
    if (tag.name === 'testsuite' || tag.name === 'testsuites') {
      if (parent && parent !== 'testsuite' && parent !== 'testsuites') report.issues.push('Misplaced test suite');
      const count = tag.attributes['tests'];
      const planned = count === undefined ? null : Number(count);
      if (count !== undefined && (!/^\d+$/.test(count) || !Number.isSafeInteger(planned))) report.issues.push('Invalid JUnit test count');
      suites.push({ firstTest: report.tests.length, planned });
    } else if (tag.name === 'testcase') {
      if (parent !== 'testsuite' || current) report.issues.push('Misplaced test case');
      const name = tag.attributes['name'] ?? '';
      const className = tag.attributes['classname'] ?? '';
      const qualified = className ? `${className}#${name}` : name;
      if (!name) report.issues.push('Unnamed test case');
      current = {
        name: qualified,
        identities: [...new Set([name, qualified])],
        group: className || null,
        groupIdentities: className ? [className, className.split('.').at(-1)!] : [],
        status: TestStatus.Passed,
      };
    } else if (current && parent === 'testcase') {
      if (tag.name === 'failure' || tag.name === 'error') {
        if (current.status === TestStatus.Skipped) report.issues.push('Contradictory JUnit status');
        current.status = TestStatus.Failed;
      }
      if (tag.name === 'skipped') {
        if (current.status === TestStatus.Failed) report.issues.push('Contradictory JUnit status');
        current.status = TestStatus.Skipped;
      }
    }
    elements.push(tag.name);
  });
  parser.on('closetag', (tag) => {
    if (tag.name === 'testcase' && current) {
      report.tests.push(current);
      current = null;
    } else if (tag.name === 'testsuite' || tag.name === 'testsuites') {
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

const adapters: TestReportAdapter[] = [
  { matches: (output) => /^(?:TAP version \d+|(?:not )?ok\b|1\.\.\d+|#)/.test(output.trimStart()), parse: parseTap },
  { matches: (output) => output.trimStart().startsWith('<'), parse: parseJunit },
];

/** Parse supported reports into one result contract; unknown/malformed input fails closed. */
export function parseTestReport(output: string): TestReport {
  const adapter = adapters.find((candidate) => candidate.matches(output));
  if (!adapter) return { format: ReportFormat.Unknown, valid: false, tests: [], issues: ['Unsupported report format'] };
  try {
    return adapter.parse(output);
  } catch {
    return { format: ReportFormat.Unknown, valid: false, tests: [], issues: ['Malformed report'] };
  }
}
