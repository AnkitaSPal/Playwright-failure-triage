# Failure triage agent workflow

How this standalone package reads Playwright results, classifies failures, verifies them, and files Jira tickets.

The installable package is the **repo root** (`playwright-failure-triage`). Source lives in `Agents/`. Host Playwright repos install from GitHub; they do not copy source.

## How to run it

From the **host Playwright project** after `npm install` and `npx playwright-triage init`:

| Command | What it starts | Who uses it |
|---|---|---|
| `npx playwright test …` | Writes the JSON report + screenshots | Input to triage |
| `npx playwright-triage ui` | Local dashboard at `http://localhost:3001` | Human-in-the-loop (recommended) |
| `npx playwright-triage` | Same analysis in the terminal | CLI; asks y/n for live real-bug checks and Jira |

Port: `TRIAGE_UI_PORT` or **3001**. Restart the UI after changing `.env` or `triage.config.json`.

`projectMatch` must appear in the Playwright project name (`shop` matches `shop-chromium`). `"login": { "skip": true }` if live verify should skip login.

Live verify needs `apps[]`. Classify and Jira work from the JSON report and screenshots alone.

Package readme: [README.md](../README.md).

---

## End-to-end picture

```
Playwright tests
    │
    ▼
test-results/test-results.json
test-results/**/test-failed-*.png
    │
    ▼
flattenResults.ts  ──► NormalizedFailure[]
    │
    ▼
batchAssessment.ts  ──► one shared cause? (uniform category)
    │
    ├─ mixed ──────────────► classify.ts (per unexpected failure)
    └─ uniform real_bug ───► classify.ts again to draft/move off Jira board
    │
    ▼
Buckets: real_bug | test_script | locator_drift | snapshot_mismatch
         | flaky_timing | environment_infra
    │
    ├─ locator_drift ──► verifyLocatorDrift.ts (one live Playwright MCP session)
    ├─ environment_infra ──► assessInfraIssue.ts (reasoning only, no browser)
    ├─ test_script / snapshot_mismatch / flaky ──► report only
    └─ real_bug ──► UI: Verify live (optional) ──► File Jira REST
    │
    ▼
.triage/last-triage-report.json
ui/  (dashboard, served from this package)
```

---

## Inputs the pipeline reads

| File / place | Who writes it | What triage uses |
|---|---|---|
| `test-results/test-results.json` | Playwright JSON reporter (`playwright.config.ts`) | Failures, statuses, errors, attachment paths |
| `test-results/**/*.png` | Playwright `screenshot: only-on-failure` | Actual failure screenshot |
| Playwright snapshot attachments (`expected` / `actual` / `diff`) | `toHaveScreenshot` / `toMatchSnapshot` | Snapshot-mismatch evidence |
| `.triage/expected-snapshots/*.png` | You (upload or “use actual as expected” in the UI) | Baseline image next to the failure shot |
| Spec files under `tests/**` | Test authors | `loginContext.ts` infers which app/role to log in as |
| `.env` + `triage.config.json` | You (in the host project) | Report path, app URLs/roles, Cursor API key, Jira REST settings |
| `CURSOR_API_KEY` | Cursor Dashboard → Integrations | Local Cursor agents (classify / live browser) |
| `JIRA_EMAIL` + `JIRA_API_TOKEN` | Atlassian API token for your user | Direct Jira REST create (reporter = that user) |
| `JIRA_CLOUD_ID`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE` | You | Jira site URL, project key, issue type (`Bug`) |

Skipped from the JSON report: tests with status `expected` or `skipped`. Kept: `unexpected` (true fail) and `flaky` (failed then passed on retry).

`classify.ts` only sends **`unexpected`** failures to the LLM. Playwright already labeled `flaky`.

---

## Outputs the pipeline writes

Paths below are host-project defaults from `triage.config.json` (`cachePath`, `expectedSnapshotsDir`).

| File | When | Contents |
|---|---|---|
| `.triage/last-triage-report.json` | After analyze / verify / file / expected-snapshot | Full dashboard state (categories, drafts, verification, Jira keys) |
| `.triage/expected-snapshots/<project>__<title>.png` | UI “use actual” or upload | Baseline screenshot |
| `.cursor-agent-store/*.ndjson` | Cursor SDK local agents | Agent run history (not the HITL report) |
| Jira issue | File in Jira | Bug with steps / expected / actual / logs; screenshot attached when the PNG exists on disk |

---

## Step-by-step logic

### 1. Dashboard boot — `triageServer.ts`

- Serves static UI from this package’s `ui/` (`index.html`, `app.js`, `styles.css`).
- Loads the cached report from `cachePath` if present.
- APIs:
  - `GET /api/state` — current job + report
  - `POST /api/analyze` — `runAnalysis`
  - `POST /api/verify` — live-check selected real bugs
  - `POST /api/file-jira` — REST-create selected drafts
  - `POST /api/expected-snapshot` — save baseline PNG
  - `GET /api/screenshot` — serve only paths from the report or expected-snapshots dir

CLI twin: `runTraige.ts` (same analysis; readline for real-bug volume + Jira pick list).

### 2. Flatten the Playwright report — `flattenResults.ts`

Walks nested `suites → specs → tests → results`. For each failed/flaky test it keeps:

- title, Playwright project name, spec file
- last error message/stack (ANSI stripped)
- attempts, `finalStatus`, last `resultStatus` (`failed` / `timedOut` / …)
- screenshot path, Playwright snapshot attachment paths, `errorLocation`
- matching file in the expected-snapshots dir if one exists

### 3. Batch “one root cause?” — `batchAssessment.ts`

One **classifier** Cursor agent looks at all failures and returns:

- `uniform: true` + a category if ~80% share a cause
- otherwise mixed

Uses `agentFactory.createClassifierAgent()` (`composer-2.5`, local, project+user settings).

### 4. Per-test classify — `classify.ts`

Each **unexpected** failure gets one isolated agent. Categories:

| Category | Meaning | Jira? | Live browser? |
|---|---|---|---|
| `real_bug` | App is wrong **and** that matches the test intent | Yes, only with `draftTicket` | Optional (Verify selected) |
| `test_script` | Title/intent disagrees with Expected vs Received (e.g. pointer vs `default`) | No | No |
| `snapshot_mismatch` | Screenshot / ARIA snapshot diff | No | No |
| `locator_drift` | Selector timeout, not found, strict mode | No | Yes, one shared session |
| `flaky_timing` | Race / intermittent, not a UI or app change | No | No |
| `environment_infra` | Network, auth, worker crash, browser closed, protocol | No | No |

`draftTicket` is stripped unless category is `real_bug`. Cards without a draft never get File in Jira.

If the batch said uniform `real_bug`, a second classify pass can **move** items to `test_script` (or others) so they leave the Jira board.

### 5. Auto follow-up during analysis — `triagePipeline.ts`

After grouping:

- **Locator drift** → `verifyLocatorDrift.ts`: one Playwright MCP browser session, login from `loginContext.ts`, suggest a locator only if it was seen live. Browser is closed in `agentFactory.closeBrowserAgent`.
- **Infra** → `assessInfraIssue.ts`: text reasoning + suggested checks, no browser.
- **Real bugs** stay unverified until you click **Verify selected live**.

### 6. Human: live-verify a real bug — `verifyRealBug.ts`

One browser agent per selected test. Uses `loginContext.ts` (reads the spec’s login helper / role when `loginFromSpec` is on). Returns steps, expected, actual, DOM evidence, `looksLikeGenuineBug`. Session is always quit afterwards.

CLI only: `gaurdRails.ts` asks y/n if real-bug count exceeds `realBugManualReviewThreshold` (default 5).

### 7. Human: file Jira — `jiraLogging.ts`

**No Cursor agent.** Direct Jira Cloud REST:

1. `POST {JIRA_CLOUD_ID}/rest/api/3/issue` — issue in `JIRA_PROJECT_KEY`
2. `POST /rest/api/3/issue/{key}/attachments` — failure PNG if it exists locally
3. Return `{ testTitle, jiraTicketKey }`

Auth: Basic `JIRA_EMAIL` + `JIRA_API_TOKEN` (Atlassian account = reporter). App test users in `.env` are **not** used for Jira.

Filing is refused if there is no `draftTicket` or if Jira does not return a key.

---

## File map (what each file does)

### Orchestration and UI

| File | Role |
|---|---|
| `triageServer.ts` | HTTP server, APIs, static UI |
| `triagePipeline.ts` | Analyze / verify / file orchestration + cache |
| `runTraige.ts` | CLI entry (`npx playwright-triage`) |
| `triageTypes.ts` | Shared report/card types |
| `ui/index.html` | Dashboard tabs |
| `ui/app.js` | Render boards, HITL buttons |
| `ui/styles.css` | Layout |

### Read Playwright → classify

| File | Role |
|---|---|
| `flattenResults.ts` | JSON report → `NormalizedFailure[]` |
| `batchAssessment.ts` | Uniform vs mixed batch |
| `classify.ts` | Per-test category + optional Jira draft |
| `agentFactory.ts` | Cursor agents: classifier, browser (+ close) |

### Verify / Jira / snapshots

| File | Role |
|---|---|
| `verifyLocatorDrift.ts` | Live locator suggestions |
| `verifyRealBug.ts` | Live real-bug confirmation |
| `assessInfraIssue.ts` | Infra checks (no browser) |
| `loginContext.ts` | Which URL/user the live agent should use |
| `gaurdRails.ts` | CLI “too many real bugs” prompt |
| `jiraLogging.ts` | Build candidates + Jira REST create/attach |
| `expectedSnapshots.ts` | Baseline PNG paths and save/upload |

### Config (this package vs host Playwright project)

| File | Role |
|---|---|
| `triage.config.json` | Host: report path, apps/roles, Jira project (no secrets) |
| `config.ts` | This package: loads host `triage.config.json` + `.env` |
| `.env` | Host: secrets and `JIRA_*` / `CURSOR_API_KEY` |
| `playwright.config.ts` | Host: JSON reporter path, projects, screenshots |
| `tests/**/*.spec.ts` | Host: scenarios that produce the JSON report |

---

## Categories vs UI tabs

| Tab | Source field on the cached report |
|---|---|
| Real bugs | `realBugs` (must include `draftTicket`) |
| Locator drift | `locatorDrift` |
| Infra | `environmentInfra` |
| Flaky / timing | `flakyTiming` |
| Test script | `testScripts` |
| Snapshot mismatch | `snapshotMismatches` |

**File selected in Jira** is hidden unless at least one real-bug card has a draft.

---

## Cursor agents vs REST (why some steps are slow)

| Step | Runtime | Typical cost |
|---|---|---|
| Batch + classify | Local Cursor agent (`composer-2.5`) | Seconds to a minute per call (model + skills) |
| Locator / real-bug live check | Local Cursor agent + Playwright MCP | Minutes (login + inspect + `browser_close`) |
| File Jira | **HTTP REST only** | A few seconds per ticket |

Classifier/browser agents use `CURSOR_API_KEY`. Jira filing does **not**.

---

## Typical loop

1. Run tests, e.g. `npx playwright test tests/example.spec.ts --project=chromium`
2. `npx playwright-triage ui` → open `http://localhost:3001`
3. **Run analysis**
4. Review tabs (test script vs real bug vs locator vs infra)
5. On real bugs with a draft: **Verify selected live** (optional)
6. **File selected in Jira** → activity shows the new issue key
7. Re-run tests + analysis after you change code; the cache is stale until then
