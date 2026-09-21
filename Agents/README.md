# playwright-failure-triage

Standalone npm package that classifies Playwright failures, optionally live-verifies them, and can file Jira bugs. Install it into **any** Playwright project. Do not copy this source into the host repo.

## Install in a Playwright project

Pick one. Run these from the **host Playwright project root**.

**From a GitHub repo** (after you push this package):

```bash
npm install git+https://github.com/YOUR_ORG/YOUR_REPO.git
```

**From a packed tarball:**

```bash
npm install /path/to/playwright-failure-triage-1.0.0.tgz
```

**From a local checkout of this package:**

```bash
npm install /path/to/PlaywrightReportTriage/Agents
```

After this package is published to the npm registry:

```bash
npm install playwright-failure-triage
```

## One-time setup in the host project

```bash
npx playwright-triage init
```

That writes `triage.config.json`. Then:

1. Playwright JSON reporter (same path as `jsonReportPath`):

```ts
reporter: [['json', { outputFile: 'test-results/test-results.json' }]],
use: { screenshot: 'only-on-failure' },
```

2. Host `.env` (secrets stay in the Playwright project, not in this package):

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

3. Edit `apps[]` in `triage.config.json` so `projectMatch` matches your Playwright project name (`shop` matches `shop-chromium`).

4. Optional scripts in the host `package.json`:

```json
"triage": "playwright-triage",
"triage:ui": "playwright-triage ui"
```

## Run

```bash
npx playwright test
npx playwright-triage ui
```

Dashboard: `http://localhost:3001`

| Command | What it does |
|---|---|
| `npx playwright-triage init` | Write `triage.config.json` |
| `npx playwright-triage` | CLI classify / verify / Jira |
| `npx playwright-triage ui` | HITL dashboard |
| `npx playwright-triage help` | Usage |

Live verify needs `apps[]` (URL + login). Classify and Jira work from the JSON report and screenshots alone.

## Pack a tarball (maintainers)

From this package folder:

```bash
npm install
npm run build
npm pack
```

That writes `playwright-failure-triage-1.0.0.tgz`. Share the file, or install it with `npm install ./playwright-failure-triage-1.0.0.tgz`.

## Publish to npm (optional)

```bash
npm run build
npm publish
```

Use an npm org scope if the unscoped name is taken (`@your-org/playwright-failure-triage`).
