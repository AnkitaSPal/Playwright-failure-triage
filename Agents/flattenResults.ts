import * as fs from 'fs';
import * as path from 'path';
import { existingExpectedSnapshot } from './expectedSnapshots';

export interface NormalizedFailure {
    testTitle: string;
    projectName: string;
    filePath: string;
    errorMessage: string;
    errorStack: string;
    attempts: number;      // total tries including retries
    finalStatus: 'unexpected' | 'flaky';
    resultStatus?: 'passed' | 'failed' | 'timedOut' | 'interrupted';
    screenshotPath?: string;
    expectedSnapshotPath?: string;
    snapshotExpectedPath?: string;
    snapshotActualPath?: string;
    snapshotDiffPath?: string;
    errorLocation?: { file: string; line: number; column: number };

  }

  interface PlaywrightReport {
    suites: PlaywrightSuite[];
  }

  interface PlaywrightSuite {
    title: string;
    file: string;
    specs: PlaywrightSpec[];
    suites?: PlaywrightSuite[]; // suites nest arbitrarily deep — file > describe > ...
  }
  interface PlaywrightSpec {
    title: string;
    file: string;
    tests: PlaywrightTest[];
  }

  interface PlaywrightTest {
    projectName: string;
    status: "expected" | "unexpected" | "flaky" | "skipped";
    results: PlaywrightResult[];
  }
  interface PlaywrightResult {
    status: "passed" | "failed" | "timedOut" | "interrupted";
    retry: number;
    error?: { message: string; stack: string };
    errors?: { message: string }[];
    attachments?: { name: string; contentType: string; path: string }[];
    errorLocation?: { file: string; line: number; column: number };
  }
  
  export function flattenResults(reportPath: string): NormalizedFailure[] {
    const abs = path.isAbsolute(reportPath)
      ? reportPath
      : path.resolve(process.cwd(), reportPath);
    const report: PlaywrightReport = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    const failures: NormalizedFailure[] = [];
  
    function walk(suite: PlaywrightSuite) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
            if (test.status === "expected" || test.status === "skipped") continue;
          const results = test.results ?? [];
          if (results.length === 0) continue;
          const lastResult = results[results.length - 1];
          const errorInfo = lastResult.error ?? lastResult.errors?.[0];
          const screenshot = lastResult.attachments?.find(
            (a) => a.contentType === "image/png"
          );
          const snapshotExpected = findAttachment(lastResult.attachments, "expected");
          const snapshotActual = findAttachment(lastResult.attachments, "actual");
          const snapshotDiff = findAttachment(lastResult.attachments, "diff");
          failures.push({
            testTitle: spec.title,
            projectName: test.projectName,
            filePath: spec.file,
            errorMessage: stripAnsi(errorInfo?.message ?? "(no error message captured)"),
            errorStack: stripAnsi((errorInfo as any)?.stack ?? ""),
            attempts: test.results.length,
            finalStatus: test.status as "unexpected" | "flaky",
            resultStatus: lastResult.status,
            screenshotPath: snapshotActual?.path ?? screenshot?.path,
            expectedSnapshotPath: snapshotExpected?.path ?? existingExpectedSnapshot(test.projectName, spec.title),
            snapshotExpectedPath: snapshotExpected?.path,
            snapshotActualPath: snapshotActual?.path,
            snapshotDiffPath: snapshotDiff?.path,
            errorLocation: lastResult.errorLocation,
          });
        }
      }

         
      for (const child of suite.suites ?? []) walk(child);
    }
  
    for (const suite of report.suites) walk(suite);
    return failures;
  }

  function stripAnsi(value: string): string {
    return value.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
  }

  function findAttachment(
    attachments: PlaywrightResult["attachments"] | undefined,
    kind: "expected" | "actual" | "diff",
  ): { name: string; contentType: string; path: string } | undefined {
    return attachments?.find((a) => {
      const name = a.name.toLowerCase();
      return name === kind || name.endsWith(`-${kind}`) || name.startsWith(`${kind}-`) || name.includes(` ${kind}`) || name.includes(`${kind} `);
    });
  }