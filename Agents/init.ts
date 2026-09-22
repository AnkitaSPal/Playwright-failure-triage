import * as fs from "node:fs";
import * as path from "node:path";
import { packageRoot } from "./config";

export function initTriageConfig(): void {
  const dest = path.resolve(process.cwd(), "triage.config.json");
  const example = path.join(packageRoot(), "triage.config.example.json");
  if (fs.existsSync(dest)) {
    console.log(`Already exists: ${dest}`);
    return;
  }
  if (!fs.existsSync(example)) {
    throw new Error(`Missing example config at ${example}`);
  }
  fs.copyFileSync(example, dest);
  console.log(`Wrote ${dest}`);
  console.log(`Next:
  1. Edit triage.config.json (apps[], jira.projectKey)
  2. Add Playwright json reporter → test-results/test-results.json
  3. Set CURSOR_API_KEY in .env (and JIRA_* to file tickets)
  4. npx playwright test && npx playwright-triage ui
  5. Re-run analysis on the same failures reuses .triage/last-triage-report.json`);
}

if (require.main === module) {
  initTriageConfig();
}
