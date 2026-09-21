/**
 * guardrail.ts
 *
 * Locator drift always gets exactly one shared
 * session regardless of count (see verifyLocatorDrift.ts) — the guardrail
 * only matters where each failure needs its OWN session, which is the
 * real_bug path.
 */

import type { NormalizedFailure } from "./flattenResults";

export interface GuardrailDecision {
  needsManualReview: boolean;
  failures: NormalizedFailure[];
  count: number;
  threshold: number;
}

export function assessManualReviewGuardrail(
  failures: NormalizedFailure[],
  threshold: number,
): GuardrailDecision {
  return {
    needsManualReview: failures.length > threshold,
    failures,
    count: failures.length,
    threshold,
  };
}

export function buildManualReviewPrompt(
  decision: GuardrailDecision,
  label: string,
): string {
  const names = decision.failures.map((f) => `  - ${f.testTitle}`).join("\n");
  return (
    `${decision.count} tests were classified as ${label} ` +
    `(threshold: ${decision.threshold}).\n${names}\n\n` +
    `Start a Playwright MCP session for each of these ${decision.count} tests ` +
    `to verify and suggest fixes? (y/n)`
  );
}