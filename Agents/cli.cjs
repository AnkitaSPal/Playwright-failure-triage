#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function load(moduleName) {
  const compiled = path.join(__dirname, "dist", `${moduleName}.js`);
  if (fs.existsSync(compiled)) {
    return require(compiled);
  }
  try {
    require("ts-node/register/transpile-only");
  } catch {
    console.error(
      "playwright-failure-triage is not built. From the package folder run: npm run build\n" +
        "Or install ts-node in the host project to run TypeScript sources.",
    );
    process.exit(1);
  }
  return require(path.join(__dirname, `${moduleName}.ts`));
}

const cmd = process.argv[2];
if (cmd === "help" || cmd === "-h" || cmd === "--help") {
  console.log(`playwright-failure-triage — classify Playwright failures, live-verify, file Jira

Run from the Playwright project root after: npm install playwright-failure-triage

  npx playwright-triage init     Write triage.config.json
  npx playwright-triage          Classify the JSON report (CLI)
  npx playwright-triage ui       HITL dashboard (http://localhost:3001)

Host project needs:
  - playwright.config.ts json reporter → test-results/test-results.json
  - .env CURSOR_API_KEY
  - optional JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
`);
  process.exit(0);
}

if (cmd === "init") {
  load("init").initTriageConfig();
} else if (cmd === "ui" || cmd === "--ui") {
  load("triageServer");
} else {
  load("runTraige");
}
