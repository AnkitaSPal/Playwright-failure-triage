import * as fs from "node:fs";
import * as path from "node:path";
import { flattenResults } from "./flattenResults";
import type { NormalizedFailure } from "./flattenResults";
import { triageAll } from "./classify";
import type { FailureCategory, TriageResult } from "./classify";
import { assessBatch } from "./batchAssessment";
import { verifyLocatorDriftBatch } from "./verifyLocatorDrift";
import { assessInfraBatch } from "./assessInfraIssue";
import { verifyRealBugFailure } from "./verifyRealBug";
import {
  buildJiraCandidates,
  fileApprovedTickets,
} from "./jiraLogging";
import { config } from "./config";
import type {
  CategorizedFailure,
  LocatorCard,
  RealBugCard,
  TicketEdits,
  TriageJobState,
  TriageReport,
} from "./triageTypes";

function reportCachePath(): string {
  return path.resolve(process.cwd(), config.cachePath);
}

type LogFn = (message: string) => void;

function emptyReport(partial?: Partial<TriageReport>): TriageReport {
  return {
    generatedAt: new Date().toISOString(),
    reportPath: config.json_report_path,
    failureCount: 0,
    batch: {
      uniform: false,
      reasoning: "",
      confidence: 0,
    },
    realBugs: [],
    locatorDrift: [],
    flakyTiming: [],
    testScripts: [],
    snapshotMismatches: [],
    environmentInfra: { items: [], assessment: null },
    ...partial,
  };
}

export function loadCachedReport(): TriageReport | null {
  const cachePath = reportCachePath();
  if (!fs.existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as TriageReport;
    parsed.testScripts ??= [];
    parsed.snapshotMismatches ??= [];
    return parsed;
  } catch {
    return null;
  }
}

export function saveReport(report: TriageReport): void {
  const cachePath = reportCachePath();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(report, null, 2), "utf8");
}

function emptyGrouped(): Record<FailureCategory, CategorizedFailure[]> {
  return {
    real_bug: [],
    locator_drift: [],
    flaky_timing: [],
    environment_infra: [],
    test_script: [],
    snapshot_mismatch: [],
  };
}

function groupByCategory(
  results: TriageResult[],
  failures: NormalizedFailure[],
): Record<FailureCategory, CategorizedFailure[]> {
  const byTitle = new Map(failures.map((f) => [f.testTitle, f]));
  const grouped = emptyGrouped();
  for (const result of results) {
    const failure = byTitle.get(result.testTitle);
    if (failure && grouped[result.category]) grouped[result.category].push({ failure, result });
  }
  return grouped;
}

function asCategorized(
  failures: NormalizedFailure[],
  results?: TriageResult[],
): CategorizedFailure[] {
  if (!results?.length) return failures.map((failure) => ({ failure }));
  const byTitle = new Map(results.map((r) => [r.testTitle, r]));
  return failures.map((failure) => ({
    failure,
    result: byTitle.get(failure.testTitle),
  }));
}

async function fillLocatorCards(
  items: CategorizedFailure[],
  log: LogFn,
): Promise<LocatorCard[]> {
  if (items.length === 0) return [];
  log(`Checking ${items.length} locator-drift failure(s) in a live browser session…`);
  try {
    const fixes = await verifyLocatorDriftBatch(items.map((i) => i.failure));
    const byTitle = new Map(fixes.map((f) => [f.testTitle, f]));
    return items.map((item) => ({
      ...item,
      fix: byTitle.get(item.failure.testTitle) ?? null,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Locator verification failed: ${message}`);
    return items.map((item) => ({ ...item, fix: null }));
  }
}

async function fillInfra(
  items: CategorizedFailure[],
  log: LogFn,
): Promise<{ items: CategorizedFailure[]; assessment: TriageReport["environmentInfra"]["assessment"] }> {
  if (items.length === 0) return { items, assessment: null };
  log(`Assessing ${items.length} environment/infra failure(s)…`);
  try {
    const assessment = await assessInfraBatch(items.map((i) => i.failure));
    return { items, assessment };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Infra assessment failed: ${message}`);
    return { items, assessment: null };
  }
}

/**
 * Classify the Playwright JSON report and enrich locator/infra groups.
 * Real-bug live verification and Jira filing stay human-triggered.
 */
export async function runAnalysis(log: LogFn = console.log): Promise<TriageReport> {
  const reportPath = config.json_report_path;
  if (!fs.existsSync(path.resolve(process.cwd(), reportPath))) {
    throw new Error(
      `Playwright JSON report not found at ${reportPath}. Run tests first.`,
    );
  }

  log(`Reading failures from ${reportPath}…`);
  const failures = flattenResults(reportPath);
  if (failures.length === 0) {
    const empty = emptyReport({
      batch: {
        uniform: false,
        reasoning: "No failed tests to triage.",
        confidence: 1,
      },
    });
    saveReport(empty);
    return empty;
  }

  log(`Found ${failures.length} failure(s). Checking for a shared root cause…`);
  const batch = await assessBatch(failures);
  log(
    batch.uniform && batch.category
      ? `Batch looks uniform (${batch.category}, confidence ${batch.confidence}).`
      : `Mixed batch — classifying each failure. ${batch.reasoning}`,
  );

  let grouped: Record<FailureCategory, CategorizedFailure[]>;

  if (batch.uniform && batch.category && batch.category in emptyGrouped()) {
    grouped = emptyGrouped();
    grouped[batch.category] = asCategorized(failures);
  } else {
    const results = await triageAll(failures);
    log(`Classified ${results.length} unexpected failure(s).`);
    grouped = groupByCategory(results, failures);
  }

  // Per-test review can overturn a uniform real_bug batch (e.g. assertion
  // vs test-intent mismatches that belong in test_script). Redistribute
  // those so they never stay on the Jira board without a draft ticket.
  const pendingRealBugs = grouped.real_bug.filter(
    (item) => item.result?.category !== "real_bug" || !item.result.draftTicket,
  );
  if (pendingRealBugs.length > 0) {
    log(`Reviewing ${pendingRealBugs.length} real-bug candidate(s) for Jira drafts…`);
    const pendingFailures = pendingRealBugs.map((g) => g.failure);
    const triageResults = await triageAll(pendingFailures);
    const redistributed = groupByCategory(triageResults, pendingFailures);
    const confirmed = grouped.real_bug.filter(
      (item) => item.result?.category === "real_bug" && item.result.draftTicket,
    );
    grouped.real_bug = [
      ...confirmed,
      ...redistributed.real_bug.filter((item) => item.result?.draftTicket),
    ];
    for (const category of Object.keys(redistributed) as FailureCategory[]) {
      if (category === "real_bug") continue;
      grouped[category].push(...redistributed[category]);
    }
    const moved = triageResults.filter((r) => r.category !== "real_bug" || !r.draftTicket);
    if (moved.length) {
      log(
        `Moved ${moved.length} item(s) off the Jira board after per-test review (${moved
          .map((r) => `${r.testTitle} → ${r.category}`)
          .join("; ")}).`,
      );
    }
  }

  const locatorDrift = await fillLocatorCards(grouped.locator_drift, log);
  const environmentInfra = await fillInfra(grouped.environment_infra, log);

  const report = emptyReport({
    failureCount: failures.length,
    batch,
    realBugs: grouped.real_bug
      .filter((item) => item.result?.draftTicket)
      .map((item) => ({
        failure: item.failure,
        result: item.result!,
        verification: null,
        filing: null,
      })),
    locatorDrift,
    flakyTiming: grouped.flaky_timing.map((item) => ({
      failure: item.failure,
      result: item.result,
    })),
    testScripts: grouped.test_script.map((item) => ({
      failure: item.failure,
      result: item.result ?? {
        testTitle: item.failure.testTitle,
        category: "test_script",
        confidence: batch.confidence,
        reasoning: batch.reasoning,
      },
    })),
    snapshotMismatches: grouped.snapshot_mismatch.map((item) => ({
      failure: item.failure,
      result: item.result ?? {
        testTitle: item.failure.testTitle,
        category: "snapshot_mismatch",
        confidence: batch.confidence,
        reasoning: batch.reasoning,
      },
    })),
    environmentInfra,
  });

  saveReport(report);
  log("Analysis complete. Waiting for human review.");
  return report;
}

export async function verifySelectedBugs(
  testTitles: string[],
  current: TriageReport,
  log: LogFn = console.log,
): Promise<TriageReport> {
  const wanted = new Set(testTitles);
  const next: TriageReport = {
    ...current,
    realBugs: current.realBugs.map((card) => ({ ...card })),
  };

  for (const card of next.realBugs) {
    if (!wanted.has(card.failure.testTitle)) continue;
    log(`Live-verifying "${card.failure.testTitle}"…`);
    try {
      card.verification = await verifyRealBugFailure(card.failure);
      log(
        card.verification.looksLikeGenuineBug
          ? `Confirmed as a likely real bug: ${card.failure.testTitle}`
          : `Live check was inconclusive: ${card.failure.testTitle}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Verification failed for "${card.failure.testTitle}": ${message}`);
    }
  }

  saveReport(next);
  return next;
}

export async function fileSelectedTickets(
  testTitles: string[],
  edits: Record<string, TicketEdits>,
  current: TriageReport,
  log: LogFn = console.log,
): Promise<TriageReport> {
  const wanted = new Set(testTitles);
  const selected = current.realBugs.filter((card) => wanted.has(card.failure.testTitle));
  if (selected.length === 0) {
    throw new Error("No matching real-bug candidates to file.");
  }

  const missingDraft = selected.filter((card) => !card.result?.draftTicket);
  if (missingDraft.length > 0) {
    throw new Error(
      `Cannot file a Jira ticket without a draft. Missing draft for: ${missingDraft
        .map((card) => card.failure.testTitle)
        .join("; ")}`,
    );
  }

  const candidates = buildJiraCandidates(
    selected.map((c) => c.result),
    selected
      .map((c) => c.verification)
      .filter((v): v is NonNullable<typeof v> => v != null),
    selected.map((c) => c.failure),
  ).map((candidate) => {
    const edit = edits[candidate.testTitle];
    if (!edit) return candidate;
    return {
      ...candidate,
      summary: edit.summary ?? candidate.summary,
      stepsToReproduce: edit.stepsToReproduce ?? candidate.stepsToReproduce,
      expectedBehavior: edit.expectedBehavior ?? candidate.expectedBehavior,
      actualResult: edit.actualResult ?? candidate.actualResult,
    };
  });

  if (candidates.length === 0) {
    throw new Error("No Jira drafts on the selected items. Filing is only available for real bugs with a draft ticket.");
  }

  log(`Filing ${candidates.length} Jira ticket(s)…`);
  const filed = await fileApprovedTickets(candidates);
  const missingKeys = filed.filter((row) => !row.jiraTicketKey);
  if (missingKeys.length > 0) {
    throw new Error(
      `Jira did not return a ticket ID for: ${missingKeys.map((row) => row.testTitle).join("; ")}`,
    );
  }
  const byTitle = new Map(filed.map((f) => [f.testTitle, f]));

  const next: TriageReport = {
    ...current,
    realBugs: current.realBugs.map((card) => ({
      ...card,
      filing: byTitle.get(card.failure.testTitle) ?? card.filing,
    })),
  };

  saveReport(next);
  log(`Filed: ${filed.map((f) => f.jiraTicketKey).join(", ")}`);
  return next;
}

export function initialJobState(report: TriageReport | null): TriageJobState {
  return {
    status: report ? "done" : "idle",
    phase: report ? "Loaded last analysis" : "Waiting to run analysis",
    logs: report ? ["Loaded cached report from disk."] : [],
    report,
  };
}
