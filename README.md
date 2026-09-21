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

| Command | What it does |
|---|---|
| `npx playwright-triage init` | Write `triage.config.json` in the host project |
| `npx playwright-triage` | CLI classify / verify / Jira |
| `npx playwright-triage ui` | HITL dashboard |
| `npx playwright-triage help` | Usage |

Live verify needs `apps[]` (URL + login). Classify and Jira work from the JSON report and screenshots alone.

## Tarball (optional)

From this repo root:

```bash
npm install
npm pack
```

Then in a Playwright project: `npm install /path/to/playwright-failure-triage-1.0.0.tgz`.
