import type { NormalizedFailure } from "./flattenResults";
import { createClassifierAgent } from "./agentFactory";

export interface InfraAssessment {
  reasoning: string;
  /** Concrete, actionable checks — not a live session, since infra issues
   *  (bad creds, network, timeouts) usually aren't visible in the DOM. */
  suggestedChecks: string[];
}

function buildPrompt(failures: NormalizedFailure[]): string {
  return `The tests below all failed in ways that look like environment or
infrastructure problems — things like authentication failures, pages timing
out before loading, connection errors, browser/context closed unexpectedly,
protocol errors, or Playwright worker crashes ("worker process unexpectedly
exited" / interrupted with no assertion). These are not UI/selector problems
and don't need a browser session to diagnose; they need the right infra checks.

Failures:
${failures
  .map((f) => `- "${f.testTitle}": ${f.errorMessage.split("\n")[0]}`)
  .join("\n")}

Based on the specific error patterns above, respond with ONLY a JSON object:
{
  "reasoning": "1-3 sentences on what's most likely happening and why, referencing the actual error text",
  "suggestedChecks": ["concrete, specific check someone should run", "..."]
}`;
}

export async function assessInfraBatch(
  failures: NormalizedFailure[],
): Promise<InfraAssessment> {
  const agent = await createClassifierAgent();
  const run = await agent.send(buildPrompt(failures));
  const result = await run.wait();

  if (result.status !== "finished" || !result.result) {
    throw new Error(
      `Infra assessment did not complete: ${result.error?.message ?? result.status}`,
    );
  }

  const jsonMatch = result.result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No structured JSON in infra assessment response: ${result.result}`);
  }

  return JSON.parse(jsonMatch[0]) as InfraAssessment;
}