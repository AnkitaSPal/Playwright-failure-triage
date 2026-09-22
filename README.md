# Playwright-failure-triage

Standalone utility that classifies Playwright test failures, optionally live-verifies them, and can file Jira bugs. Install it into **any** Playwright project. Do not copy this source into the host repo.

Repo: [https://github.com/AnkitaSPal/Playwright-failure-triage](https://github.com/AnkitaSPal/Playwright-failure-triage.git)

## Use in a Playwright project

Run these from the **host Playwright project root** (the repo that already has `playwright.config.ts`).

### 1. Install from GitHub

```bash
npm install https://github.com/AnkitaSPal/Playwright-failure-triage.git
```

When this repo gets new commits, re-run that command (or `npm update playwright-failure-triage`) in the host project.

### 2. Initialise

```bash
npx playwright-triage init
```

That copies the template into **your** project as `triage.config.json`. Do not edit `Agents/triage.config.example.json` inside this repo or in `node_modules`.

The command name is `playwright-triage` (not `playwright-traige`).

### 3. Configure for your app

Edit the generated **`triage.config.json`**. Use [`Agents/triage.config.example.json`](Agents/triage.config.example.json) as the reference:

- `jsonReportPath` — must match your Playwright JSON reporter output
- `apps[]` — `projectMatch` must appear in the Playwright project name (`shop` matches `shop-chromium`)
- `jira` — optional, for filing bugs

Add the JSON reporter in `playwright.config.ts`:

```ts
reporter: [['json', { outputFile: 'test-results/test-results.json' }]],
use: { screenshot: 'only-on-failure' },
```

Host `.env` (secrets stay here, not in this GitHub repo):

```
CURSOR_API_KEY=...
JIRA_EMAIL=...
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=PROJ
APP_BASE_URL=https://...
APP_TEST_USERNAME=...
APP_TEST_PASSWORD=...
```

Get `CURSOR_API_KEY` from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).

### 4. Run

```bash
npx playwright test
npx playwright-triage ui
```

Dashboard: `http://localhost:3001` → **Run analysis**.

The first analysis calls the classifier LLM and writes `.triage/last-triage-report.json` (including a `sourceHash` of the failure set). **Run analysis** again, or `npx playwright-triage`, **skips the LLM** when title, project, status, and error text are unchanged. The activity log will say *Reusing cached categories; skipped LLM.* Live-verify and Jira results on that cache are kept.

A new test run that changes an error (or deleting `.triage/last-triage-report.json`) forces a fresh classification.

| Command | What it does |
|---|---|
| `npx playwright-triage init` | Write `triage.config.json` in the host project |
| `npx playwright-triage` | CLI classify / verify / Jira (reuses cache when `sourceHash` matches) |
| `npx playwright-triage ui` | HITL dashboard |
| `npx playwright-triage help` | Usage |

Live verify needs `apps[]` (URL + login). Classify and Jira work from the JSON report and screenshots alone.

### Port already in use (`EADDRINUSE`)

Closing the browser tab does **not** stop the dashboard server. The Node process keeps listening on `3001`, so the next `npx playwright-triage ui` fails with `listen EADDRINUSE: address already in use :::3001`.

**Windows — find the leftover PID, then kill it:**

```powershell
netstat -ano | findstr :3001
```

The last number on the `LISTENING` line is the PID:

```text
TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    4068
```

```powershell
Get-Process -Id 4068
taskkill /PID 4068 /F
npx playwright-triage ui
```

One-liner to free port 3001:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**macOS / Linux:**

```bash
lsof -i :3001
kill <PID>
npx playwright-triage ui
```

Replace `3001` / `4068` with the port and PID from the error and `netstat` / `lsof`.

## Tarball (optional)

From this repo root:

```bash
npm install
npm pack
```

Then in a Playwright project: `npm install /path/to/playwright-failure-triage-1.0.0.tgz`.
