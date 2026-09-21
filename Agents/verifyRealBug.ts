import type { NormalizedFailure } from "./flattenResults";
import { withBrowserAgent } from "./agentFactory";
import { formatLoginBlock, resolveLoginContext } from "./loginContext";

export interface RealBugVerification {
  testTitle: string;
  /** Ordered steps the agent actually took to reach the failure, in plain
   *  language — becomes the ticket's "Steps to Reproduce". */
  stepsToReproduce: string[];
  /** What should have happened, inferred from the test's intent. */
  expectedBehavior: string;
  /** What the agent actually confirmed happened, in plain terms. */
  confirmedBehavior: string;
  /** Concrete DOM/UI evidence — e.g. "button has disabled attribute", or
   *  "element is genuinely absent from the DOM, not just mis-selected". */
  domEvidence: string;
  looksLikeGenuineBug: boolean;
}

function buildPrompt(failure: NormalizedFailure): string {
  const login = resolveLoginContext(failure);
  return `This Playwright test failure was classified as a likely real bug —
not a broken locator or flaky timing. Use the Playwright MCP tools to open
the relevant page in a live browser and confirm what's actually happening.
Common real-bug shapes: a button that's present but disabled when it
shouldn't be, an element that's genuinely missing from the DOM (not just
mis-selected), or the page showing wrong data/state.

Do not read config.ts, .env, or GitHub secrets yourself — credentials are
already provided below. Do not assume anything from the error text alone;
confirm it live. After you have confirmed, call Playwright MCP browser_close
to quit the live browser before returning JSON. Do not leave Chromium open.

${formatLoginBlock(login)}

Test: ${failure.testTitle}
File: ${failure.filePath}
Error: ${failure.errorMessage}

Respond with ONLY a JSON object:
{
  "stepsToReproduce": ["step 1 in plain language", "step 2", "..."],
  "expectedBehavior": "what should have happened, based on the test's intent",
  "confirmedBehavior": "what you actually observed happening on the live page",
  "domEvidence": "the specific DOM/UI detail that supports this",
  "looksLikeGenuineBug": boolean
}`;
}

/**
 * One browser session per real-bug candidate — unlike locator drift, these
 * usually have different, unrelated causes, so they can't share a session.
 * Callers are expected to have already gated this behind the manual-review
 * guardrail when the count is large.
 */
export async function verifyRealBugFailure(
  failure: NormalizedFailure,
): Promise<RealBugVerification> {
  return withBrowserAgent(async (agent) => {
    const run = await agent.send(buildPrompt(failure));
    const result = await run.wait();

    if (result.status !== "finished" || !result.result) {
      throw new Error(
        `Real-bug verification did not complete for "${failure.testTitle}": ${result.error?.message ?? result.status}`,
      );
    }

    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No structured JSON in verification response for "${failure.testTitle}"`);
    }

    return { testTitle: failure.testTitle, ...JSON.parse(jsonMatch[0]) };
  });
}