import "dotenv/config";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { URL } from "node:url";
import {
  fileSelectedTickets,
  initialJobState,
  loadCachedReport,
  runAnalysis,
  saveReport,
  verifySelectedBugs,
} from "./triagePipeline";
import type { TicketEdits, TriageJobState } from "./triageTypes";
import {
  allFailures,
  applyExpectedPath,
  isInsideExpectedDir,
  saveExpectedFromFailure,
  saveExpectedFromUpload,
} from "./expectedSnapshots";
import { config, packageRoot } from "./config";

const PORT = Number(process.env.TRIAGE_UI_PORT ?? config.uiPort);
const UI_DIR = path.join(packageRoot(), "ui");

let job: TriageJobState = initialJobState(loadCachedReport());
let running = false;

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  job.logs = [...job.logs.slice(-80), line];
  job.phase = message;
  console.log(line);
}

async function withJob<T>(phase: string, work: () => Promise<T>): Promise<T | undefined> {
  if (running) {
    throw new Error("Another triage job is already running.");
  }
  running = true;
  job = {
    ...job,
    status: "running",
    phase,
    error: undefined,
  };
  log(phase);
  try {
    const result = await work();
    job.status = "done";
    job.phase = "Ready for review";
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.status = "error";
    job.error = message;
    log(message);
    return undefined;
  } finally {
    running = false;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function mime(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function serveStatic(res: http.ServerResponse, urlPath: string) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const filePath = path.resolve(UI_DIR, relative);
  if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    json(res, 404, { error: "Not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": mime(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function allowedScreenshotPaths(): Set<string> {
  const paths = new Set<string>();
  if (!job.report) return paths;
  for (const failure of allFailures(job.report)) {
    if (failure.screenshotPath) paths.add(path.resolve(failure.screenshotPath));
    if (failure.expectedSnapshotPath) paths.add(path.resolve(failure.expectedSnapshotPath));
  }
  return paths;
}

function serveScreenshot(res: http.ServerResponse, rawPath: string) {
  const absolute = path.resolve(rawPath);
  const allowed =
    allowedScreenshotPaths().has(absolute) || isInsideExpectedDir(absolute);
  if (!allowed || !fs.existsSync(absolute)) {
    json(res, 404, { error: "Screenshot not available" });
    return;
  }
  res.writeHead(200, { "Content-Type": mime(absolute) });
  fs.createReadStream(absolute).pipe(res);
}

function findFailure(testTitle: string, projectName: string) {
  if (!job.report) throw new Error("Run analysis first.");
  const failure = allFailures(job.report).find(
    (item) => item.testTitle === testTitle && (!projectName || item.projectName === projectName),
  );
  if (!failure) throw new Error(`No failure found for "${testTitle}".`);
  return failure;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, job);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/screenshot") {
      serveScreenshot(res, url.searchParams.get("path") ?? "");
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      if (running) {
        json(res, 409, { error: "Another triage job is already running.", ...job });
        return;
      }
      void withJob("Starting analysis…", async () => {
        job.report = await runAnalysis(log);
      });
      json(res, 202, job);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/verify") {
      const body = JSON.parse((await readBody(req)) || "{}") as { testTitles?: string[] };
      if (!job.report) throw new Error("Run analysis first.");
      if (running) {
        json(res, 409, { error: "Another triage job is already running.", ...job });
        return;
      }
      const report = job.report;
      void withJob("Starting live verification…", async () => {
        job.report = await verifySelectedBugs(body.testTitles ?? [], report, log);
      });
      json(res, 202, job);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/file-jira") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        testTitles?: string[];
        edits?: Record<string, TicketEdits>;
      };
      if (!job.report) throw new Error("Run analysis first.");
      if (running) {
        json(res, 409, { error: "Another triage job is already running.", ...job });
        return;
      }
      const report = job.report;
      void withJob("Filing Jira tickets…", async () => {
        job.report = await fileSelectedTickets(
          body.testTitles ?? [],
          body.edits ?? {},
          report,
          log,
        );
      });
      json(res, 202, job);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/expected-snapshot") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        testTitle?: string;
        projectName?: string;
        imageBase64?: string;
      };
      const failure = findFailure(body.testTitle ?? "", body.projectName ?? "");
      const expectedPath = body.imageBase64
        ? saveExpectedFromUpload(failure, Buffer.from(body.imageBase64, "base64"))
        : saveExpectedFromFailure(failure);
      applyExpectedPath(job.report!, failure.testTitle, failure.projectName, expectedPath);
      saveReport(job.report!);
      json(res, 200, job);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(res, url.pathname);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 400, { error: message, ...job });
  }
});

server.listen(PORT, () => {
  console.log(`Triage dashboard: http://localhost:${PORT}`);
});
