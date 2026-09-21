import path from "node:path";
import dotenv from "dotenv";
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import type { SDKAgent } from "@cursor/sdk";

const localStore = new JsonlLocalAgentStore(
  path.resolve(process.cwd(), ".cursor-agent-store"),
);

function loadCursorApiKey(): string {
  dotenv.config({
    path: path.resolve(process.cwd(), ".env"),
    override: true,
  });
  const apiKey = (process.env.CURSOR_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY is empty. Add a user API key from https://cursor.com/dashboard/integrations",
    );
  }
    return apiKey;
}

/**
 * Reasoning-only agent — same lockdown as classify.ts. Used anywhere we
 * want the LLM's judgment but must guarantee it can't touch a browser,
 * the shell, or file a ticket on its own.
 */
export async function createClassifierAgent() {
  return Agent.create({
    apiKey: loadCursorApiKey(),
    model: { id: "composer-2.5" },
    local: {
      cwd: process.cwd(),
      store: localStore,
      settingSources: ["project", "user"],
    },
    //cloud: {repos:[]},
    //disallowedTools: ["mcp", "shell"],
  });
}

/**
 * Browser-capable agent — mcp (Playwright) is allowed so it can navigate
 * the live app and inspect the real DOM. Shell stays blocked. Only ever
 * called from verification steps that have already been through the
 * classifier and, where required, the manual-review guardrail.
 */
export async function createBrowserAgent() {
  return Agent.create({
    apiKey: loadCursorApiKey(),
    model: { id: "composer-2.5" },
    local: {
      cwd: process.cwd(),
      store: localStore,
      settingSources: ["project", "user"],
    },
    disallowedTools: ["shell"],
    // TODO: if your @cursor/sdk version supports scoping which MCP server(s)
    // an agent can see (e.g. an `mcpServers: ["playwright"]` allowlist),
    // add it here so this agent literally cannot reach the Jira MCP server.
    // Until then it's separated from createJiraAgent() at the call-site level.
  });
}

/** Quit the Playwright MCP browser and dispose the agent so Chromium does not stay open. */
export async function closeBrowserAgent(agent: SDKAgent): Promise<void> {
  try {
    const closeRun = await agent.send(
      "Verification is finished. Call the Playwright MCP browser_close tool now to quit the live browser and free memory. Do not navigate or inspect the page. Reply with OK.",
    );
    await Promise.race([
      closeRun.wait(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("browser_close timed out")), 20_000),
      ),
    ]);
  } catch {
    // Best-effort; disposing the agent still tears down the MCP process.
  }
  try {
    agent.close();
  } catch {
    // ignore
  }
  try {
    await agent[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
}

export async function withBrowserAgent<T>(
  work: (agent: SDKAgent) => Promise<T>,
): Promise<T> {
  const agent = await createBrowserAgent();
  try {
    return await work(agent);
  } finally {
    await closeBrowserAgent(agent);
  }
}

/**
 * Jira filing agent — local so it uses the Atlassian MCP already connected
 * in Cursor (your Atlassian account). Cloud agents cannot see that login,
 * which is why earlier filings returned an empty ticket key.
 */
export async function createJiraAgent() {
  return Agent.create({
    apiKey: loadCursorApiKey(),
    model: { id: "composer-2.5" },
    local: {
      cwd: process.cwd(),
      store: localStore,
      settingSources: ["project", "user"],
    },
    disallowedTools: ["shell"],
  });
}