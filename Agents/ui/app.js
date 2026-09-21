const state = {
  job: null,
  tab: "real_bug",
};

const els = {
  status: document.getElementById("job-status"),
  phase: document.getElementById("job-phase"),
  summary: document.getElementById("summary"),
  batch: document.getElementById("batch"),
  tabs: document.getElementById("tabs"),
  boards: document.getElementById("boards"),
  realBugs: document.getElementById("real-bugs"),
  locator: document.getElementById("locator-drift"),
  infra: document.getElementById("infra"),
  flaky: document.getElementById("flaky"),
  testScripts: document.getElementById("test-scripts"),
  snapshotMismatches: document.getElementById("snapshot-mismatches"),
  logs: document.getElementById("logs"),
  run: document.getElementById("run-analysis"),
  verify: document.getElementById("verify-selected"),
  file: document.getElementById("file-selected"),
  selectAll: document.getElementById("select-all-bugs"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

function firstLine(text) {
  return stripAnsi(text).split("\n")[0];
}

function shotSrc(filePath) {
  return `/api/screenshot?path=${encodeURIComponent(filePath)}`;
}

function snapshotCompare(failure) {
  const actualPath = failure.snapshotActualPath || failure.screenshotPath;
  const expectedPath = failure.snapshotExpectedPath || failure.expectedSnapshotPath;
  const actual = actualPath
    ? `<figure><figcaption>Actual (failure)</figcaption><img class="shot" alt="Actual failure screenshot" src="${shotSrc(actualPath)}" /></figure>`
    : `<p class="meta">No failure screenshot in this run.</p>`;
  const expected = expectedPath
    ? `<figure><figcaption>Expected</figcaption><img class="shot" alt="Expected snapshot" src="${shotSrc(expectedPath)}" /></figure>`
    : `<p class="meta">No expected snapshot yet. Upload one, or save the actual shot as the baseline.</p>`;
  const diff = failure.snapshotDiffPath
    ? `<figure><figcaption>Diff</figcaption><img class="shot" alt="Snapshot diff" src="${shotSrc(failure.snapshotDiffPath)}" /></figure>`
    : "";
  return `<div class="snapshot-compare">
    ${expected}
    ${actual}
    ${diff}
  </div>
  <div class="snapshot-actions">
    <button type="button" class="ghost save-expected" data-title="${escapeHtml(failure.testTitle)}" data-project="${escapeHtml(failure.projectName)}" ${actualPath ? "" : "disabled"}>
      Use actual as expected
    </button>
    <label class="ghost file-btn">
      Upload expected
      <input type="file" accept="image/png,image/jpeg" class="expected-upload" data-title="${escapeHtml(failure.testTitle)}" data-project="${escapeHtml(failure.projectName)}" hidden />
    </label>
  </div>`;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Request failed");
  return body;
}

function selectedTitles() {
  return [...document.querySelectorAll(".bug-select:checked")].map((el) => el.value);
}

function fileableSelectedTitles() {
  return [...document.querySelectorAll(".bug-select:checked")]
    .filter((el) => el.dataset.hasDraft === "true")
    .map((el) => el.value);
}

function editsFor(titles) {
  const wanted = new Set(titles);
  const edits = {};
  document.querySelectorAll(".bug-select").forEach((box) => {
    if (!wanted.has(box.value)) return;
    const card = box.closest(".card");
    if (!card) return;
    edits[box.value] = {
      summary: card.querySelector("[name=summary]")?.value,
      expectedBehavior: card.querySelector("[name=expected]")?.value,
      actualResult: card.querySelector("[name=actual]")?.value,
      stepsToReproduce: (card.querySelector("[name=steps]")?.value || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  });
  return edits;
}

function renderJob(job) {
  const wasRunning = state.job?.status === "running";
  state.job = job;
  els.status.textContent = job.status;
  els.status.className = `pill ${job.status}`;
  els.phase.textContent = job.error || job.phase;
  els.logs.textContent = (job.logs || []).join("\n");
  const busy = job.status === "running";
  els.run.disabled = busy;
  els.verify.disabled = busy;
  els.file.disabled = busy;

  const report = job.report;
  if (!report) return;
  // Keep ticket edits intact while a background job is still running.
  if (busy && wasRunning) return;

  els.summary.hidden = false;
  els.batch.hidden = false;
  els.tabs.hidden = false;
  els.boards.hidden = false;

  els.summary.innerHTML = [
    ["real_bug", "Real bugs", report.realBugs.length],
    ["locator_drift", "Locator drift", report.locatorDrift.length],
    ["environment_infra", "Infra", report.environmentInfra.items.length],
    ["flaky_timing", "Flaky / timing", report.flakyTiming.length],
    ["test_script", "Test script", (report.testScripts || []).length],
    ["snapshot_mismatch", "Snapshot mismatch", (report.snapshotMismatches || []).length],
  ]
    .map(
      ([key, label, count]) =>
        `<article class="tile ${key}"><span>${label}</span><strong>${count}</strong></article>`,
    )
    .join("");

  els.batch.innerHTML = `<strong>${report.batch.uniform ? "Shared root cause" : "Mixed failures"}</strong>
    <p>${escapeHtml(report.batch.reasoning || "No batch reasoning yet.")}</p>
    <p class="meta">${report.failureCount} failure(s) from ${escapeHtml(report.reportPath)}</p>`;

  renderRealBugs(report.realBugs);
  renderLocators(report.locatorDrift);
  renderInfra(report.environmentInfra);
  renderFlaky(report.flakyTiming);
  renderTestScripts(report.testScripts || []);
  renderSnapshotMismatches(report.snapshotMismatches || []);
}

function renderRealBugs(cards) {
  const fileableCount = cards.filter((card) => card.result?.draftTicket).length;
  els.file.hidden = fileableCount === 0;
  if (!cards.length) {
    els.realBugs.innerHTML = `<p class="empty">No real-bug candidates in this run.</p>`;
    return;
  }
  els.realBugs.innerHTML = cards
    .map((card) => {
      const v = card.verification;
      const filed = card.filing?.jiraTicketKey;
      const canFile = Boolean(card.result?.draftTicket);
      const steps = (v?.stepsToReproduce || []).join("\n");
      const badge = filed
        ? filed
        : !canFile
          ? "Not fileable — no Jira draft"
          : v
            ? v.looksLikeGenuineBug
              ? "Verified live"
              : "Inconclusive"
            : "Needs review";
      const badgeClass = filed || v?.looksLikeGenuineBug ? "ok" : !canFile ? "warn" : v ? "warn" : "";
      const jiraFields = canFile
        ? `<label class="field">Jira summary
          <input name="summary" type="text" value="${escapeHtml(card.result.draftTicket.summary)}" />
        </label>
        <label class="field">Steps to reproduce
          <textarea name="steps">${escapeHtml(steps)}</textarea>
        </label>
        <label class="field">Expected
          <textarea name="expected">${escapeHtml(v?.expectedBehavior || "")}</textarea>
        </label>
        <label class="field">Actual
          <textarea name="actual">${escapeHtml(v?.confirmedBehavior || "")}</textarea>
        </label>`
        : `<p class="meta">No Jira draft — filing is disabled for this item. Re-run analysis if it should be a product bug.</p>`;
      return `<article class="card" data-title="${escapeHtml(card.failure.testTitle)}" data-has-draft="${canFile}">
        <div class="card-head">
          <label>
            <input class="bug-select" type="checkbox" data-has-draft="${canFile}" value="${escapeHtml(card.failure.testTitle)}" />
            <strong>${escapeHtml(card.failure.testTitle)}</strong>
          </label>
          <span class="badge ${badgeClass}">${escapeHtml(badge)}</span>
        </div>
        <p class="meta">${escapeHtml(card.failure.filePath)} · ${escapeHtml(card.failure.projectName)} · confidence ${card.result.confidence ?? "—"}</p>
        <p>${escapeHtml(card.result.reasoning || "")}</p>
        ${jiraFields}
        ${v?.domEvidence ? `<p class="meta">DOM: ${escapeHtml(v.domEvidence)}</p>` : ""}
        <pre class="error-block">${escapeHtml(stripAnsi(card.failure.errorMessage))}</pre>
        ${snapshotCompare(card.failure)}
      </article>`;
    })
    .join("");
}

function renderLocators(cards) {
  if (!cards.length) {
    els.locator.innerHTML = `<p class="empty">No locator-drift failures in this run.</p>`;
    return;
  }
  els.locator.innerHTML = cards
    .map((card) => {
      const fix = card.fix;
      return `<article class="card">
        <h3>${escapeHtml(card.failure.testTitle)}</h3>
        <p class="meta">${escapeHtml(card.failure.filePath)}</p>
        <p>${escapeHtml(card.result?.reasoning || firstLine(card.failure.errorMessage))}</p>
        ${
          fix
            ? `<p><strong>Broken:</strong> <code>${escapeHtml(fix.brokenLocator)}</code></p>
               <p><strong>Suggested:</strong> <code>${escapeHtml(fix.suggestedLocator ?? "none found")}</code></p>
               <p class="meta">${escapeHtml(fix.domEvidence)}</p>`
            : `<p class="meta">No live locator suggestion yet.</p>`
        }
        <pre class="error-block">${escapeHtml(stripAnsi(card.failure.errorMessage))}</pre>
        ${snapshotCompare(card.failure)}
      </article>`;
    })
    .join("");
}

function renderInfra(group) {
  if (!group.items.length) {
    els.infra.innerHTML = `<p class="empty">No environment/infra failures in this run.</p>`;
    return;
  }
  const checks = (group.assessment?.suggestedChecks || [])
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join("");
  els.infra.innerHTML = `
    <article class="card">
      <h3>Infra assessment</h3>
      <p>${escapeHtml(group.assessment?.reasoning || "No assessment yet.")}</p>
      ${checks ? `<ul>${checks}</ul>` : ""}
    </article>
    ${group.items
      .map(
        (item) => `<article class="card">
          <h3>${escapeHtml(item.failure.testTitle)}</h3>
          <pre class="error-block">${escapeHtml(stripAnsi(item.failure.errorMessage))}</pre>
          ${snapshotCompare(item.failure)}
        </article>`,
      )
      .join("")}`;
}

function renderFlaky(cards) {
  if (!cards.length) {
    els.flaky.innerHTML = `<p class="empty">No flaky/timing failures in this run.</p>`;
    return;
  }
  els.flaky.innerHTML = cards
    .map(
      (card) => `<article class="card">
        <h3>${escapeHtml(card.failure.testTitle)}</h3>
        <p>${escapeHtml(card.result?.reasoning || "Classified as flaky/timing — no live check.")}</p>
        <pre class="error-block">${escapeHtml(stripAnsi(card.failure.errorMessage))}</pre>
        ${snapshotCompare(card.failure)}
      </article>`,
    )
    .join("");
}

function renderTestScripts(cards) {
  if (!cards.length) {
    els.testScripts.innerHTML = `<p class="empty">No test-script mismatches in this run. Flagged when the test intent does not match the asserted expected result.</p>`;
    return;
  }
  els.testScripts.innerHTML = cards
    .map(
      (card) => `<article class="card">
        <h3>${escapeHtml(card.failure.testTitle)}</h3>
        <p>${escapeHtml(card.result?.reasoning || "Test intent does not match the asserted expected result — update the script, do not file a product bug.")}</p>
        <pre class="error-block">${escapeHtml(stripAnsi(card.failure.errorMessage))}</pre>
        ${snapshotCompare(card.failure)}
      </article>`,
    )
    .join("");
}

function renderSnapshotMismatches(cards) {
  if (!cards.length) {
    els.snapshotMismatches.innerHTML = `<p class="empty">No screenshot or snapshot comparison failures in this run.</p>`;
    return;
  }
  els.snapshotMismatches.innerHTML = cards
    .map(
      (card) => `<article class="card">
        <h3>${escapeHtml(card.failure.testTitle)}</h3>
        <p>${escapeHtml(card.result?.reasoning || "Screenshot or snapshot comparison failed.")}</p>
        <pre class="error-block">${escapeHtml(stripAnsi(card.failure.errorMessage))}</pre>
        ${snapshotCompare(card.failure)}
      </article>`,
    )
    .join("");
}

els.tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  state.tab = button.dataset.tab;
  els.tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === button));
  document.querySelectorAll(".board").forEach((board) => {
    board.hidden = board.dataset.board !== state.tab;
  });
});

els.selectAll.addEventListener("change", () => {
  document.querySelectorAll(".bug-select").forEach((box) => {
    box.checked = els.selectAll.checked;
  });
});

async function startAction(path, body) {
  renderJob(await api(path, { method: "POST", body: JSON.stringify(body ?? {}) }));
  poll();
}

els.run.addEventListener("click", async () => {
  try {
    await startAction("/api/analyze");
  } catch (error) {
    alert(error.message);
  }
});

els.verify.addEventListener("click", async () => {
  const testTitles = selectedTitles();
  if (!testTitles.length) return alert("Select at least one real-bug candidate.");
  try {
    await startAction("/api/verify", { testTitles });
  } catch (error) {
    alert(error.message);
  }
});

els.file.addEventListener("click", async () => {
  const selected = selectedTitles();
  const testTitles = fileableSelectedTitles();
  if (!selected.length) return alert("Select at least one real-bug candidate.");
  if (!testTitles.length) {
    return alert("None of the selected items have a Jira draft, so filing is disabled.");
  }
  if (testTitles.length !== selected.length) {
    return alert("Some selected items have no Jira draft and cannot be filed. Unselect those first.");
  }
  try {
    await startAction("/api/file-jira", { testTitles, edits: editsFor(testTitles) });
  } catch (error) {
    alert(error.message);
  }
});

async function saveExpected(testTitle, projectName, imageBase64) {
  const job = await api("/api/expected-snapshot", {
    method: "POST",
    body: JSON.stringify({ testTitle, projectName, imageBase64 }),
  });
  renderJob(job);
}

els.boards.addEventListener("click", async (event) => {
  const button = event.target.closest(".save-expected");
  if (!button) return;
  try {
    await saveExpected(button.dataset.title, button.dataset.project);
  } catch (error) {
    alert(error.message);
  }
});

els.boards.addEventListener("change", async (event) => {
  const input = event.target.closest(".expected-upload");
  if (!input?.files?.[0]) return;
  const file = input.files[0];
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  try {
    await saveExpected(input.dataset.title, input.dataset.project, btoa(binary));
  } catch (error) {
    alert(error.message);
  }
});

async function poll() {
  try {
    const job = await api("/api/state");
    renderJob(job);
  } catch (error) {
    els.phase.textContent = error.message;
  }
}

poll();
setInterval(() => {
  if (state.job?.status === "running") poll();
}, 1500);
