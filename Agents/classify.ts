import { Agent } from "@cursor/sdk";
import type { NormalizedFailure } from "./flattenResults";
import { createClassifierAgent as classifyAgent } from "./agentFactory";

export type FailureCategory =
  | "real_bug"
  | "locator_drift"
  | "flaky_timing"
  | "environment_infra"
  | "test_script"
  | "snapshot_mismatch";

export interface DraftTicket {
  summary: string;
  description: string;
}

export interface TriageResult {
  testTitle: string;
  category: FailureCategory;
  confidence: number;
  reasoning: string;
  draftTicket?: DraftTicket;// only present when category === "real_bug"
}

function buildPrompt(failure: NormalizedFailure): string {
    return `You are triaging a failed Playwright test as a senior QA automation engineer.
   
  Test: ${failure.testTitle}
  File: ${failure.filePath}
  Attempts made: ${failure.attempts}
  Playwright outcome: ${failure.finalStatus}${failure.resultStatus ? ` / last attempt ${failure.resultStatus}` : ""}
  Error message: ${failure.errorMessage}
  Stack trace (truncated): ${failure.errorStack.slice(0, 500)}
  Visual comparison attachments: expected=${failure.snapshotExpectedPath ? "yes" : "no"}, actual=${failure.snapshotActualPath ? "yes" : "no"}, diff=${failure.snapshotDiffPath ? "yes" : "no"}
   
  Classify this failure into exactly one category:
  - real_bug: the application returned wrong data, state, or content, AND that
    mismatch matches what the test title/intent was trying to prove.
    Only then include draftTicket.
  - test_script: the test's own intent does not match what it asserts.
    Typical signal: Expected vs Received (toBe / toContain / toHaveCSS / toHaveText)
    where the received value matches the test title/intent and the expected
    value does not. Example: title says Buy Hardware should show a pointer
    cursor, assertion expects "default", app returned "pointer".
    This is NOT locator_drift and NOT a product bug. Do not include draftTicket.
  - snapshot_mismatch: toHaveScreenshot / toMatchSnapshot / toMatchAriaSnapshot
    failed (pixel, image, or ARIA snapshot diff). Use this even if Expected vs
    Received appears in the message, as long as it is a visual/snapshot compare.
  - locator_drift: ONLY a selector timeout, "waiting for locator/selector",
    element not found, or "strict mode violation". Never use locator_drift for
    a passing locator whose assertion value is simply wrong.
  - flaky_timing: an intermittent/race-condition-style failure, not explained by
    a UI or app change.
  - environment_infra: network errors, auth failures, missing test data,
    connection issues, browser/context closed unexpectedly, protocol errors,
    AND worker crashes ("worker process unexpectedly exited", interrupted with
    no assertion). Do not invent a new category for worker crashes.
   
  Be conservative with "real_bug" — only use it when the error clearly shows
  wrong application output that the test was actually intending to catch.
  Prefer test_script over real_bug AND over locator_drift when the received
  value matches the test title/intent and the expected value does not.
  Prefer snapshot_mismatch over real_bug/test_script when the failure is a
  screenshot or snapshot comparison.
   
  Respond with ONLY a single JSON object (no prose before or after it), shaped
  exactly like this:
   
  {
    "category": "real_bug" | "test_script" | "snapshot_mismatch" | "locator_drift" | "flaky_timing" | "environment_infra",
    "confidence": 0.0-1.0,
    "reasoning": "1-2 sentences referencing the specific error text",
    "draftTicket": {
      "summary": "short Jira summary line",
      "description": "full description including error, file, and repro context"
    }
  }
   
  Include "draftTicket" only if category is "real_bug". Omit it entirely otherwise.`;
  }
   
  export async function triageFailure(
    failure: NormalizedFailure
  ): Promise<TriageResult> {
    // One agent per failure keeps each classification isolated — no leftover
    // context from a previous test's error bleeding into this one's reasoning.
    // const agent = await Agent.create({
    //   apiKey: process.env.CURSOR_API_KEY!,
    //   model: { id: "composer-2.5" },
    //   local: {
    //     cwd: process.cwd(),}, // must be your repo root so context resolves correctly
        // Classification is pure text/image reasoning — it never needs to touch
        // Jira, the shell, or any other tool. Blocking "mcp" and "shell" here
        // means there's no accidental ticket creation possible, regardless of
        // what the prompt says. This is a real safety boundary, not a prompt
        // instruction — local agents execute tool calls with no human-in-the-
        // loop approval by default, so this is the actual guardrail.
    
    
    // });
    const agent = await classifyAgent();
    const run = await agent.send(buildPrompt(failure));
    const result = await run.wait();
   
    if (result.status !== "finished" || !result.result) {
      throw new Error(
        `Triage did not complete for test "${failure.testTitle}": ${result.error?.message ?? result.status}`
      );
    }
   
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(
        `No structured JSON found in response for test: ${failure.testTitle}\nRaw response: ${result.result}`
      );
    }
   
    const parsed = JSON.parse(jsonMatch[0]) as TriageResult;
    parsed.testTitle = parsed.testTitle || failure.testTitle;
    if (parsed.category !== "real_bug") {
      delete parsed.draftTicket;
    }
    return parsed;
  }
   
  export async function triageAll(
    failures: NormalizedFailure[],
    concurrency = 3
  ): Promise<TriageResult[]> {
    // Only "unexpected" failures (never recovered on retry) go to the agent.
    // "flaky" ones already told you what they are via Playwright's own
    // status field — no need to spend an API call classifying them.
    const genuineFailures = failures.filter((f) => f.finalStatus === "unexpected");
   
    const results: TriageResult[] = [];
    const queue = [...genuineFailures];
   
    async function worker() {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        results.push(await triageFailure(next));
      }
    }
   
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  }