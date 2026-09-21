import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { flattenResults } from "./flattenResults";
import type { NormalizedFailure } from "./flattenResults";
import { triageAll } from "./classify";
import type { TriageResult, FailureCategory } from "./classify";
import { assessBatch } from "./batchAssessment";
import { verifyLocatorDriftBatch } from "./verifyLocatorDrift";
import { assessInfraBatch } from "./assessInfraIssue";
import { verifyRealBugFailure } from "./verifyRealBug";
import { assessManualReviewGuardrail, buildManualReviewPrompt } from "./gaurdRails";
import { buildJiraCandidates, promptJiraSelection, fileApprovedTickets } from "./jiraLogging";
import { config } from "./config";

const REAL_BUG_MANUAL_REVIEW_THRESHOLD =
  config.realBugManualReviewThreshold?? 5;

async function main() {
  const failures = flattenResults(config.json_report_path);
  if (failures.length === 0) {
    console.log("No failed tests to triage.");
    return;
  }

  // Step 1 (requirement 1 & 5): ask the LLM if this batch shares one root
  // cause before spending a classification call per failure.
  const batch = await assessBatch(failures);

  if (batch.uniform && batch.category) {
    console.log(
      `${failures.length} failures look like a single ${batch.category} cause: ${batch.reasoning}`,
    );
    await routeByCategory(batch.category, failures);
    return;
  }

  // Mixed batch — fall back to per-failure classification, then group.
  console.log(
    `Failures don't share one root cause (${batch.reasoning}). Classifying individually.`,
  );
  const results = await triageAll(failures);
  const grouped = groupByCategory(results, failures);

  for (const category of Object.keys(grouped) as FailureCategory[]) {
    const group = grouped[category];
    if (group.length === 0) continue;
    await routeByCategory(
      category,
      group.map((g) => g.failure),
      group.map((g) => g.result),
    );
  }
}

function groupByCategory(
  results: TriageResult[],
  failures: NormalizedFailure[],
): Record<FailureCategory, { failure: NormalizedFailure; result: TriageResult }[]> {
  const byTitle = new Map(failures.map((f) => [f.testTitle, f]));
  const grouped: Record<FailureCategory, { failure: NormalizedFailure; result: TriageResult }[]> = {
    real_bug: [],
    locator_drift: [],
    flaky_timing: [],
    environment_infra: [],
    test_script: [],
    snapshot_mismatch: [],
  };
  for (const r of results) {
    const f = byTitle.get(r.testTitle);
    if (f && grouped[r.category]) grouped[r.category].push({ failure: f, result: r });
  }
  return grouped;
}

async function routeByCategory(
  category: FailureCategory,
  failures: NormalizedFailure[],
  results?: TriageResult[],
) {
  switch (category) {
    case "locator_drift": {
      // Requirement 2: one shared root cause -> one session for the whole group.
      const fixes = await verifyLocatorDriftBatch(failures);
      console.log(`\n-- Locator drift fixes --`);
      console.log(JSON.stringify(fixes, null, 2));
      break;
    }

    case "environment_infra": {
      // Requirement 3: reasoning only, no browser session.
      const assessment = await assessInfraBatch(failures);
      console.log(`\n-- Infra assessment --`);
      console.log(JSON.stringify(assessment, null, 2));
      break;
    }

    case "real_bug": {
      // Draft tickets are per-test, so even a "uniform batch" verdict still
      // needs individual classification results here — Jira filing has to
      // reference each test's own summary/description. That second pass can
      // also overturn the batch label (test_script, locator_drift, …).
      const triageResults = results ?? (await triageAll(failures));
      const redistributed = groupByCategory(triageResults, failures);
      const remaining = redistributed.real_bug.filter((g) => g.result.draftTicket);

      for (const other of Object.keys(redistributed) as FailureCategory[]) {
        if (other === "real_bug" || redistributed[other].length === 0) continue;
        console.log(
          `Reclassified ${redistributed[other].length} failure(s) from real_bug to ${other}.`,
        );
        await routeByCategory(
          other,
          redistributed[other].map((g) => g.failure),
          redistributed[other].map((g) => g.result),
        );
      }

      if (remaining.length === 0) {
        console.log("No real-bug candidates with a Jira draft remain; skipping ticket filing.");
        break;
      }

      const remainingFailures = remaining.map((g) => g.failure);
      const remainingResults = remaining.map((g) => g.result);

      const decision = assessManualReviewGuardrail(
        remainingFailures,
        REAL_BUG_MANUAL_REVIEW_THRESHOLD,
      );
      let approvedForVerification = !decision.needsManualReview;

      if (decision.needsManualReview) {
        const rl = readline.createInterface({ input, output });
        const answer = await rl.question(
          buildManualReviewPrompt(decision, "real_bug") + " ",
        );
        rl.close();
        approvedForVerification = answer.trim().toLowerCase().startsWith("y");
      }

      console.log(`\n-- Real bug reasoning --`);
      console.log(JSON.stringify(remainingResults, null, 2));

      if (!approvedForVerification) {
        console.log(
          `Skipped live verification for ${remainingFailures.length} real_bug candidates.`,
        );
        break;
      }

      const verifications = [];
      for (const f of remainingFailures) verifications.push(await verifyRealBugFailure(f));
      console.log(`\n-- Real bug live verification --`);
      console.log(JSON.stringify(verifications, null, 2));

      const candidates = buildJiraCandidates(remainingResults, verifications, remainingFailures);
      if (candidates.length === 0) {
        console.log("No Jira drafts present; skipping ticket filing.");
        break;
      }
      const approvedTickets = await promptJiraSelection(candidates);

      if (approvedTickets.length === 0) {
        console.log("No tickets selected for filing.");
        break;
      }

      const filed = await fileApprovedTickets(approvedTickets);
      console.log(`\n-- Jira tickets filed --`);
      console.log(JSON.stringify(filed, null, 2));
      break;
    }

    case "flaky_timing": {
      console.log(`\n-- Flaky/timing (no live check) --`);
      if (results) console.log(JSON.stringify(results, null, 2));
      else console.log(`${failures.length} failures look like flaky/timing issues.`);
      break;
    }

    case "test_script": {
      console.log(`\n-- Test script (intent vs assertion mismatch; do not file a product bug) --`);
      if (results) console.log(JSON.stringify(results, null, 2));
      else console.log(`${failures.length} failure(s) look like outdated or contradictory test assertions.`);
      break;
    }

    case "snapshot_mismatch": {
      console.log(`\n-- Snapshot mismatch (screenshot / snapshot compare; do not file as locator drift) --`);
      if (results) console.log(JSON.stringify(results, null, 2));
      else console.log(`${failures.length} failure(s) look like visual or ARIA snapshot diffs.`);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});