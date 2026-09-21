import type { NormalizedFailure } from "./flattenResults";
import type { FailureCategory } from "./classify";
import { createClassifierAgent } from "./agentFactory";

export interface BatchAssessment {
  /** True if the LLM judged that (nearly) all failures share one root cause. */
  uniform: boolean;
  /** Set only when uniform === true. */
  category?: FailureCategory;
  /** Why the LLM believes it's one shared cause (or why it isn't). */
  reasoning: string;
  confidence: number;
}

function summarize(failure: NormalizedFailure): string {
  const firstLine = failure.errorMessage.split("\n")[0];
  const location = failure.errorLocation
    ? `${failure.errorLocation.file}:${failure.errorLocation.line}`
    : failure.filePath;
  return `- "${failure.testTitle}" (${location}): ${firstLine}`;
}

function extractJsonObject(raw: string): string {
  const openBrace = String.fromCharCode(123);
  const closeBrace = String.fromCharCode(125);
  const start = raw.indexOf(openBrace);
  const end = raw.lastIndexOf(closeBrace);
  if (start < 0 || end <= start) {
    throw new Error("No structured JSON in batch assessment response: " + raw);
  }
  return raw.slice(start, end + 1);
}

function buildPrompt(failures: NormalizedFailure[]): string {
  const count = failures.length;
  const failureList = failures.map(summarize).join("\n");

  return [
    `You are looking at ${count} failed Playwright tests from a single run.`,
    "Before anyone classifies these one by one, decide: do the vast majority of them",
    "share ONE common root cause (e.g. a single component/selector changed across",
    "the app, or one shared piece of infrastructure is down), or are they a mix of",
    "unrelated issues?",
    "",
    "Failures:",
    failureList,
    "",
    "Respond with ONLY a single JSON object, no prose before or after.",
    "Required keys:",
    "uniform: boolean",
    "category: real_bug | test_script | snapshot_mismatch | locator_drift | flaky_timing | environment_infra | null",
    "reasoning: 1-3 sentences citing the specific shared pattern, or why it is mixed",
    "confidence: number from 0.0 to 1.0",
    "",
    'Only set "uniform" to true if at least ~80% of the failures point to the same',
    'cause. If it is a genuine mix, set "uniform" to false and "category" to mixed;',
    "do not force a single label onto a mixed batch.",
    'Use "snapshot_mismatch" when the shared pattern is screenshot/snapshot compare',
    "failures. Use \"environment_infra\" when the shared pattern is worker crashes,",
    "browser closed, protocol errors, auth, or network.",
    'Use "test_script" when titles/intent disagree with Expected vs Received',
    "(for example cursor should be pointer but the assertion expects default).",
    "Do not label that pattern real_bug or locator_drift.",
  ].join("\n");
}

export async function assessBatch(
  failures: NormalizedFailure[],
): Promise<BatchAssessment> {
  const agent = await createClassifierAgent();
  const run = await agent.send(buildPrompt(failures));
  const result = await run.wait();

  if (result.status !== "finished" || !result.result) {
    throw new Error(
      "Batch assessment did not complete: " + (result.error?.message ?? result.status),
    );
  }

  return JSON.parse(extractJsonObject(result.result)) as BatchAssessment;
}