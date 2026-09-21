import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { TriageResult } from "./classify";
import type { NormalizedFailure } from "./flattenResults";
import type { RealBugVerification } from "./verifyRealBug";
import { config } from "./config";

/**
 * The required Jira ticket structure: steps to reproduce, expected vs.
 * actual result, logs, and a screenshot — everything a reviewer needs
 * without re-running the test themselves.
 */
export interface JiraCandidate {
  testTitle: string;
  summary: string;
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualResult: string;
  domEvidence: string;
  /** Error message + truncated stack from the original Playwright report. */
  logs: string;
  screenshotPath?: string;
  looksLikeGenuineBug: boolean;
}

export interface JiraFilingResult {
  testTitle: string;
  jiraTicketKey: string;
}

/**
 * Jira attachment requires a local file path on the machine running this
 * script — so the screenshot has to actually exist here. This matters most
 * in CI: the triage step must run in the same job/workspace as the test
 * execution, not a later job that only pulled down the JSON report as an
 * artifact (in which case the screenshot file simply won't be present).
 */
function resolveScreenshotPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined;
  const absolutePath = path.resolve(rawPath);
  if (!fs.existsSync(absolutePath)) {
    console.warn(
      `Screenshot referenced in the report but not found on disk, skipping attachment: ${absolutePath}`,
    );
    return undefined;
  }
  return absolutePath;
}

/**
 * Combine each real_bug TriageResult's draft summary with its live
 * verification and the original failure's logs/screenshot. Failures
 * without a draftTicket are skipped — never file a ticket with empty content.
 */
export function buildJiraCandidates(
  results: TriageResult[],
  verifications: RealBugVerification[],
  failures: NormalizedFailure[],
): JiraCandidate[] {
  const verificationByTitle = new Map(verifications.map((v) => [v.testTitle, v]));
  const failureByTitle = new Map(failures.map((f) => [f.testTitle, f]));
  const candidates: JiraCandidate[] = [];

  for (const r of results) {
    if (!r.draftTicket) continue;
    const v = verificationByTitle.get(r.testTitle);
    const f = failureByTitle.get(r.testTitle);

    candidates.push({
      testTitle: r.testTitle,
      summary: r.draftTicket.summary,
      stepsToReproduce: v?.stepsToReproduce ?? ["(not live-verified — see original error below)"],
      expectedBehavior: v?.expectedBehavior ?? "(not live-verified)",
      actualResult: v?.confirmedBehavior ?? "(not live-verified)",
      domEvidence: v?.domEvidence ?? "",
      logs: f
        ? `${f.errorMessage}\n${f.errorStack.slice(0, 500)}`
        : r.draftTicket.description,
      screenshotPath: resolveScreenshotPath(f?.screenshotPath),
      looksLikeGenuineBug: v?.looksLikeGenuineBug ?? false,
    });
  }

  return candidates;
}

/**
 * Shows each candidate with its evidence and asks the user to pick which
 * ones to actually file — never a blanket yes/no across the whole set.
 */
export async function promptJiraSelection(
  candidates: JiraCandidate[],
): Promise<JiraCandidate[]> {
  if (candidates.length === 0) return [];

  console.log(`\n${candidates.length} real-bug candidate(s) ready to review:\n`);
  candidates.forEach((c, i) => {
    console.log(
      `[${i + 1}] ${c.testTitle}` +
        `${c.looksLikeGenuineBug ? "" : "  (live check was inconclusive)"}\n` +
        `    Summary: ${c.summary}\n` +
        `    Expected: ${c.expectedBehavior}\n` +
        `    Actual:   ${c.actualResult}\n` +
        `    Screenshot: ${c.screenshotPath ?? "(none found on this machine)"}\n`,
    );
  });

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(
    `Enter numbers to log to Jira (e.g. "1,3"), "all", or "none": `,
  );
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "none" || trimmed === "") return [];
  if (trimmed === "all") return candidates;

  const indices = trimmed
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < candidates.length);

  return indices.map((i) => candidates[i]);
}

function jiraSite(): string {
  return config.jira_cloud_id.replace(/\/$/, "");
}

function jiraAuthHeader(): string {
  const email = config.jira_email.trim();
  const token = config.jira_api_token.trim();
  if (!email || !token) {
    throw new Error(
      "JIRA_EMAIL and JIRA_API_TOKEN are required for REST filing. Create a token at https://id.atlassian.com/manage-profile/security/api-tokens and add both to .env.",
    );
  }
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

function adfDoc(sections: Array<{ heading: string; body: string }>) {
  const content: object[] = [];
  for (const section of sections) {
    content.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: section.heading }],
    });
    const lines = (section.body || "(none)").split("\n");
    content.push({
      type: "paragraph",
      content: lines.flatMap((line, index) => {
        const text = { type: "text", text: line.length ? line : " " };
        return index < lines.length - 1 ? [text, { type: "hardBreak" }] : [text];
      }),
    });
  }
  return { type: "doc", version: 1, content };
}

function candidateDescription(candidate: JiraCandidate) {
  return adfDoc([
    { heading: "Test", body: candidate.testTitle },
    {
      heading: "Steps to Reproduce",
      body: candidate.stepsToReproduce.map((step, i) => `${i + 1}. ${step}`).join("\n"),
    },
    { heading: "Expected Result", body: candidate.expectedBehavior },
    {
      heading: "Actual Result",
      body: [candidate.actualResult, candidate.domEvidence && `DOM: ${candidate.domEvidence}`]
        .filter(Boolean)
        .join("\n"),
    },
    { heading: "Logs", body: candidate.logs },
  ]);
}

async function jiraJson<T>(
  pathname: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<T> {
  const { headers, ...rest } = init;
  const response = await fetch(`${jiraSite()}${pathname}`, {
    ...rest,
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: "application/json",
      ...headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jira REST ${response.status} ${pathname}: ${text.slice(0, 800)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function createJiraIssue(candidate: JiraCandidate): Promise<string> {
  const created = await jiraJson<{ key?: string }>("/rest/api/3/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        project: { key: config.jira_project_key },
        issuetype: { name: config.jira_issue_type },
        summary: candidate.summary,
        description: candidateDescription(candidate),
      },
    }),
  });
  if (!created.key) {
    throw new Error(`Jira created an issue without a key for "${candidate.testTitle}".`);
  }
  return created.key;
}

async function attachScreenshot(issueKey: string, filePath: string): Promise<void> {
  const form = new FormData();
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  form.append(
    "file",
    new Blob([bytes], { type: "image/png" }),
    path.basename(filePath),
  );
  await jiraJson(`/rest/api/3/issue/${issueKey}/attachments`, {
    method: "POST",
    headers: { "X-Atlassian-Token": "no-check" },
    body: form,
  });
}

/**
 * Files each approved candidate with Jira Cloud REST (same API the Atlassian
 * MCP createJiraIssue tool wraps). Reporter is the JIRA_EMAIL / API token owner.
 */
export async function fileApprovedTickets(
  approved: JiraCandidate[],
): Promise<JiraFilingResult[]> {
  if (approved.length === 0) return [];
  if (!config.jira_project_key) {
    throw new Error(
      "JIRA_PROJECT_KEY is missing. Add it to .env (for example JIRA_PROJECT_KEY=TB).",
    );
  }

  const filed: JiraFilingResult[] = [];
  for (const candidate of approved) {
    const jiraTicketKey = await createJiraIssue(candidate);
    if (candidate.screenshotPath) {
      try {
        await attachScreenshot(jiraTicketKey, candidate.screenshotPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Created ${jiraTicketKey} but screenshot attach failed: ${message}`);
      }
    }
    filed.push({ testTitle: candidate.testTitle, jiraTicketKey });
  }
  return filed;
}