import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";
import type { NormalizedFailure } from "./flattenResults";
import type { TriageReport } from "./triageTypes";

export function expectedSnapshotDir(): string {
  return path.resolve(process.cwd(), config.expectedSnapshotsDir);
}

export function snapshotFileName(projectName: string, testTitle: string): string {
  const key = `${projectName}__${testTitle}`
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
  return `${key || "untitled"}.png`;
}

export function expectedSnapshotPath(projectName: string, testTitle: string): string {
  return path.join(expectedSnapshotDir(), snapshotFileName(projectName, testTitle));
}

export function existingExpectedSnapshot(
  projectName: string,
  testTitle: string,
): string | undefined {
  const filePath = expectedSnapshotPath(projectName, testTitle);
  return fs.existsSync(filePath) ? filePath : undefined;
}

export function ensureExpectedDir(): void {
  fs.mkdirSync(expectedSnapshotDir(), { recursive: true });
}

export function isInsideExpectedDir(absolutePath: string): boolean {
  const relative = path.relative(expectedSnapshotDir(), absolutePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function saveExpectedFromFailure(failure: NormalizedFailure): string {
  if (!failure.screenshotPath) {
    throw new Error("This failure has no Playwright screenshot to copy.");
  }
  const source = path.resolve(failure.screenshotPath);
  if (!fs.existsSync(source)) {
    throw new Error(`Failure screenshot not found on disk: ${source}`);
  }
  ensureExpectedDir();
  const dest = expectedSnapshotPath(failure.projectName, failure.testTitle);
  fs.copyFileSync(source, dest);
  return dest;
}

export function saveExpectedFromUpload(
  failure: NormalizedFailure,
  bytes: Buffer,
): string {
  ensureExpectedDir();
  const dest = expectedSnapshotPath(failure.projectName, failure.testTitle);
  fs.writeFileSync(dest, bytes);
  return dest;
}

export function allFailures(report: TriageReport): NormalizedFailure[] {
  return [
    ...report.realBugs.map((c) => c.failure),
    ...report.locatorDrift.map((c) => c.failure),
    ...report.flakyTiming.map((c) => c.failure),
    ...(report.testScripts ?? []).map((c) => c.failure),
    ...(report.snapshotMismatches ?? []).map((c) => c.failure),
    ...report.environmentInfra.items.map((c) => c.failure),
  ];
}

export function applyExpectedPath(
  report: TriageReport,
  testTitle: string,
  projectName: string,
  expectedPath: string,
): void {
  for (const failure of allFailures(report)) {
    if (failure.testTitle === testTitle && failure.projectName === projectName) {
      failure.expectedSnapshotPath = expectedPath;
    }
  }
}
