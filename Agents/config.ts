import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";

/** Package root, whether running from source or compiled `dist/`. */
export function packageRoot(): string {
  const here = path.resolve(__dirname);
  return path.basename(here) === "dist" ? path.resolve(here, "..") : here;
}

export const AGENTS_DIR = packageRoot();

export interface TriageRoleFile {
  usernameEnv?: string;
  passwordEnv?: string;
  username?: string;
  password?: string;
}

export interface TriageAppFile {
  key: string;
  /** Fallback URL if `baseURLEnv` is empty. */
  baseURL?: string;
  baseURLEnv?: string;
  /** Substring of the Playwright project name, e.g. "shop" matches "shop-chromium". */
  projectMatch?: string;
  defaultRole?: string;
  login?: {
    skip?: boolean;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
    notes?: string;
  };
  roles?: Record<string, TriageRoleFile>;
}

export interface TriageFileConfig {
  jsonReportPath?: string;
  expectedSnapshotsDir?: string;
  cachePath?: string;
  uiPort?: number;
  realBugManualReviewThreshold?: number;
  loginFromSpec?: boolean;
  jira?: {
    cloudId?: string;
    projectKey?: string;
    issueType?: string;
  };
  apps?: TriageAppFile[];
}

export interface ResolvedRole {
  username: string;
  password: string;
}

export interface ResolvedApp {
  key: string;
  baseURL: string;
  projectMatch: string;
  defaultRole: string;
  login: {
    skip: boolean;
    usernameSelector: string;
    passwordSelector: string;
    submitSelector: string;
    notes: string;
  };
  roles: Record<string, ResolvedRole>;
}

export interface TriageConfig {
  json_report_path: string;
  expectedSnapshotsDir: string;
  cachePath: string;
  uiPort: number;
  realBugManualReviewThreshold: number;
  loginFromSpec: boolean;
  jira_cloud_id: string;
  jira_project_key: string;
  jira_issue_type: string;
  jira_email: string;
  jira_api_token: string;
  apps: ResolvedApp[];
}

function readJsonConfig(): TriageFileConfig {
  const named = process.env.TRIAGE_CONFIG;
  const candidates = [
    named ? path.resolve(process.cwd(), named) : "",
    path.resolve(process.cwd(), "triage.config.json"),
    path.join(packageRoot(), "triage.config.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8")) as TriageFileConfig;
    }
  }
  return {};
}

function envOr(name: string | undefined, fallback = ""): string {
  if (!name) return fallback;
  const value = process.env[name];
  return value != null && value !== "" ? value : fallback;
}

function resolveRole(role: TriageRoleFile | undefined): ResolvedRole {
  return {
    username: envOr(role?.usernameEnv, role?.username ?? ""),
    password: envOr(role?.passwordEnv, role?.password ?? ""),
  };
}

function resolveApp(app: TriageAppFile): ResolvedApp {
  const roles: Record<string, ResolvedRole> = {};
  for (const [name, role] of Object.entries(app.roles ?? {})) {
    roles[name] = resolveRole(role);
  }
  return {
    key: app.key,
    baseURL: envOr(app.baseURLEnv, app.baseURL ?? ""),
    projectMatch: (app.projectMatch ?? app.key).toLowerCase(),
    defaultRole: app.defaultRole ?? "user",
    login: {
      skip: Boolean(app.login?.skip),
      usernameSelector: app.login?.usernameSelector ?? "input#username",
      passwordSelector: app.login?.passwordSelector ?? "input#password",
      submitSelector: app.login?.submitSelector ?? "input[type=submit]",
      notes: app.login?.notes ?? "",
    },
    roles,
  };
}

function loadTriageConfig(): TriageConfig {
  dotenv.config({
    path: path.resolve(process.cwd(), process.env.ENV_FILE ?? ".env"),
  });
  const file = readJsonConfig();
  const uiPort = Number(process.env.TRIAGE_UI_PORT ?? file.uiPort ?? 3001);
  return {
    json_report_path:
      process.env.TRIAGE_JSON_REPORT ??
      file.jsonReportPath ??
      "test-results/test-results.json",
    expectedSnapshotsDir:
      file.expectedSnapshotsDir ?? ".triage/expected-snapshots",
    cachePath: file.cachePath ?? ".triage/last-triage-report.json",
    uiPort: Number.isFinite(uiPort) ? uiPort : 3001,
    realBugManualReviewThreshold: file.realBugManualReviewThreshold ?? 5,
    loginFromSpec: file.loginFromSpec !== false,
    jira_cloud_id:
      process.env.JIRA_CLOUD_ID ?? file.jira?.cloudId ?? "",
    jira_project_key: process.env.JIRA_PROJECT_KEY ?? file.jira?.projectKey ?? "",
    jira_issue_type: process.env.JIRA_ISSUE_TYPE ?? file.jira?.issueType ?? "Bug",
    jira_email: process.env.JIRA_EMAIL ?? "",
    jira_api_token: process.env.JIRA_API_TOKEN ?? "",
    apps: (file.apps ?? []).map(resolveApp),
  };
}

export const config: TriageConfig = loadTriageConfig();
