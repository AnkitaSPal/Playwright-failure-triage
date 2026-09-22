import type { BatchAssessment } from "./batchAssessment";
import type { FailureCategory, TriageResult } from "./classify";
import type { NormalizedFailure } from "./flattenResults";
import type { InfraAssessment } from "./assessInfraIssue";
import type { LocatorFix } from "./verifyLocatorDrift";
import type { RealBugVerification } from "./verifyRealBug";
import type { JiraFilingResult } from "./jiraLogging";

export type JobStatus = "idle" | "running" | "done" | "error";

export interface RealBugCard {
  failure: NormalizedFailure;
  result: TriageResult;
  verification: RealBugVerification | null;
  filing: JiraFilingResult | null;
}

export interface LocatorCard {
  failure: NormalizedFailure;
  result?: TriageResult;
  fix: LocatorFix | null;
}

export interface FlakyCard {
  failure: NormalizedFailure;
  result?: TriageResult;
}

export interface TestScriptCard {
  failure: NormalizedFailure;
  result?: TriageResult;
}

export interface SnapshotMismatchCard {
  failure: NormalizedFailure;
  result?: TriageResult;
}

export interface CategorizedFailure {
  failure: NormalizedFailure;
  result?: TriageResult;
}

export interface TriageReport {
  generatedAt: string;
  reportPath: string;
  /** SHA-256 of flattened failures; rerun analysis skips the LLM when this matches. */
  sourceHash?: string;
  failureCount: number;
  batch: BatchAssessment;
  realBugs: RealBugCard[];
  locatorDrift: LocatorCard[];
  flakyTiming: FlakyCard[];
  testScripts: TestScriptCard[];
  snapshotMismatches: SnapshotMismatchCard[];
  environmentInfra: {
    items: CategorizedFailure[];
    assessment: InfraAssessment | null;
  };
}

export interface TriageJobState {
  status: JobStatus;
  phase: string;
  logs: string[];
  error?: string;
  report: TriageReport | null;
}

export interface TicketEdits {
  summary?: string;
  stepsToReproduce?: string[];
  expectedBehavior?: string;
  actualResult?: string;
}

export type { FailureCategory };
