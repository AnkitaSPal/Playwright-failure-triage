import type { NormalizedFailure } from "./flattenResults";
import { withBrowserAgent } from "./agentFactory";
import { formatLoginBlocks, uniqueLoginContexts } from "./loginContext";

export interface LocatorFix {
  testTitle: string;
  brokenLocator: string;
  /** Only ever a locator the agent actually found on the live page — never a guess. */
  suggestedLocator: string | null;
  /** What the agent saw in the DOM that justifies the suggestion. */
  domEvidence: string;
}

function buildPrompt(failures: NormalizedFailure[]): string {
  const logins = uniqueLoginContexts(failures);
  return `The tests below all failed with what looks like the same root cause:
a UI selector no longer matches the page (locator drift). Use the Playwright
MCP tools to actually open the relevant page(s) in a live browser session and
inspect the current DOM — do not rely on the error text or the old selector
alone, and do not guess. Do not read config.ts or .env yourself.

${formatLoginBlocks(logins)}

For each test:
1. Navigate to the page it's testing.
2. Look for the element the old locator was trying to match (same role,
   nearby text, or same position in the layout).
3. Only report a "suggestedLocator" if you actually found a matching element
   in the DOM during this session. If nothing plausible is found, set it to
   null and explain what you saw instead in "domEvidence".

You only need to open each distinct page once, even if multiple tests below
target it. When finished, call Playwright MCP browser_close to quit the live
browser before returning JSON. Do not leave Chromium open.

Failures:
${failures
  .map(
    (f) =>
      `- "${f.testTitle}" — error: ${f.errorMessage.split("\n")[0]}`,
  )
  .join("\n")}

Respond with ONLY a JSON array, no prose, shaped exactly like this:
[
  {
    "testTitle": string,
    "brokenLocator": string,
    "suggestedLocator": string | null,
    "domEvidence": "what you actually observed in the live DOM"
  }
]`;
}

/**
 * One shared session covers the whole group — locator drift is usually one
 * root cause (a component or page redesign), so there's no need to open a
 * separate browser per failing test.
 */
export async function verifyLocatorDriftBatch(
  failures: NormalizedFailure[],
): Promise<LocatorFix[]> {
  return withBrowserAgent(async (agent) => {
    const run = await agent.send(buildPrompt(failures));
    const result = await run.wait();

    if (result.status !== "finished" || !result.result) {
      throw new Error(
        `Locator verification session did not complete: ${result.error?.message ?? result.status}`,
      );
    }

    const jsonMatch = result.result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(`No structured JSON array in locator verification response: ${result.result}`);
    }

    return JSON.parse(jsonMatch[0]) as LocatorFix[];
  });
}