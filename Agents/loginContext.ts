import * as fs from "fs";
import * as path from "path";
import { config, type ResolvedApp } from "./config";
import type { NormalizedFailure } from "./flattenResults";

export interface LoginContext {
  app: string;
  role: string;
  baseURL: string;
  username: string;
  password: string;
  skipLogin: boolean;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  notes: string;
}

interface SourceBlock {
  kind: "describe" | "test";
  title: string;
  start: number;
  end: number;
}

/**
 * Login for this failure: Playwright project name → triage.config.json app,
 * then (optional) spec-file performLogin / login() to pick the role.
 *
 * New Playwright repo: add an `apps[]` entry to triage.config.json whose
 * `projectMatch` matches the Playwright project name (e.g. "shop" → shop-chromium).
 */
export function resolveLoginContext(failure: NormalizedFailure): LoginContext {
  const extracted = config.loginFromSpec
    ? extractCredsFromTestFile(failure)
    : undefined;
  const app = getAppProject(
    extracted?.app ?? appKeyFromFailure(failure),
    failure,
  );
  const pair = extracted
    ? pairFromFields(app, extracted.usernameField)
    : defaultUserPair(app);

  return requireCreds(app, pair.role, pair.username, pair.password);
}

export function uniqueLoginContexts(failures: NormalizedFailure[]): LoginContext[] {
  const seen = new Set<string>();
  const out: LoginContext[] = [];
  for (const failure of failures) {
    const login = resolveLoginContext(failure);
    const id = `${login.app}:${login.role}:${login.username}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(login);
  }
  return out;
}

export function formatLoginBlock(login: LoginContext): string {
  if (login.skipLogin) {
    return `No login required for ${login.app}.
- URL: ${login.baseURL}/
${login.notes ? `- Note: ${login.notes}` : ""}
Open the page directly and inspect the DOM.`;
  }
  return `Log in first (the page is useless until you do):
- App: ${login.app} (${login.role})
- URL: ${login.baseURL}/
- Username field: ${login.usernameSelector}
- Password field: ${login.passwordSelector}
- Submit: ${login.submitSelector}
- Username: ${login.username}
- Password: ${login.password}
${login.notes ? `- Note: ${login.notes}` : ""}

Never echo the password in your JSON, ticket text, or stepsToReproduce.
If login fails, stop and report that — do not guess at authenticated pages.`;
}

export function formatLoginBlocks(logins: LoginContext[]): string {
  if (logins.length <= 1) return formatLoginBlock(logins[0]);
  return (
    `These failures use more than one login. Use the matching role per test:\n\n` +
    logins.map((login, i) => `(${i + 1}) ${formatLoginBlock(login)}`).join("\n\n")
  );
}

function appKeyFromFailure(failure: NormalizedFailure): string {
  const project = (failure.projectName ?? "").toLowerCase();
  for (const app of config.apps) {
    if (project.includes(app.projectMatch) || project.split("-")[0] === app.key) {
      return app.key;
    }
  }

  const haystack = `${failure.filePath} ${failure.testTitle}`.toLowerCase();
  for (const app of config.apps) {
    if (haystack.includes(app.key) || haystack.includes(app.projectMatch)) {
      return app.key;
    }
  }
  throw new Error(
    `Could not tell which app "${failure.testTitle}" belongs to ` +
      `(project "${failure.projectName ?? ""}"). Add an apps[] entry in triage.config.json ` +
      `whose projectMatch matches the Playwright project name.`,
  );
}

function getAppProject(key: string, failure: NormalizedFailure): ResolvedApp {
  const app = lookupAppProject(key);
  if (app) return app;
  throw new Error(
    `No triage.config.json app "${key}" (test "${failure.testTitle}"). ` +
      `Add it under apps[] with baseURL/baseURLEnv and roles.`,
  );
}

function lookupAppProject(key: string): ResolvedApp | undefined {
  const needle = key.toLowerCase();
  return config.apps.find(
    (app) => app.key.toLowerCase() === needle || app.projectMatch === needle,
  );
}

function defaultUserPair(app: ResolvedApp): {
  role: string;
  username: string;
  password: string;
} {
  return pairFromFields(app, app.defaultRole);
}

function pairFromFields(
  app: ResolvedApp,
  usernameField: string,
): { role: string; username: string; password: string } {
  const role =
    usernameField === "username"
      ? app.defaultRole
      : usernameField.replace(/Username$/, "") || app.defaultRole;
  const creds = app.roles[role] ?? app.roles[app.defaultRole] ?? { username: "", password: "" };
  return {
    role: app.roles[role] ? role : app.defaultRole,
    username: creds.username,
    password: creds.password,
  };
}

function requireCreds(
  app: ResolvedApp,
  role: string,
  username: string,
  password: string,
): LoginContext {
  if (!app.login.skip && (!username || !password)) {
    throw new Error(
      `Missing ${app.key} "${role}" credentials. Set the env vars named in ` +
        `triage.config.json apps[].roles.${role} (usernameEnv / passwordEnv).`,
    );
  }
  if (!app.login.skip && !app.baseURL) {
    throw new Error(
      `Missing base URL for app "${app.key}". Set ${app.key.toUpperCase()} baseURLEnv in triage.config.json.`,
    );
  }
  return {
    app: app.key,
    role,
    baseURL: app.baseURL,
    username,
    password,
    skipLogin: app.login.skip,
    usernameSelector: app.login.usernameSelector,
    passwordSelector: app.login.passwordSelector,
    submitSelector: app.login.submitSelector,
    notes: app.login.notes,
  };
}

function extractCredsFromTestFile(
  failure: NormalizedFailure,
): { app?: string; usernameField: string; passwordField: string } | undefined {
  const source = readSpecSource(failure.filePath);
  if (!source) return undefined;

  const blocks = collectBlocks(source);
  const testBlock = findTestBlock(blocks, failure);
  const slices: string[] = [];

  if (testBlock) {
    slices.push(source.slice(testBlock.start, testBlock.end));
    const describes = blocks
      .filter((b) => b.kind === "describe" && b.start <= testBlock.start && b.end >= testBlock.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    // Only the suite's beforeEach — not sibling tests in the same describe
    // (loginPage.spec.ts mixes user / admin / wrong in one describe).
    for (const describe of describes) {
      slices.push(...extractBeforeEachSlices(source, describe));
    }
  }

  for (const slice of slices) {
    const found = parseLoginCall(slice);
    if (found) return found;
  }
  return undefined;
}

function extractBeforeEachSlices(source: string, describe: SourceBlock): string[] {
  const slices: string[] = [];
  const re = /test\.beforeEach\s*\(/g;
  const body = source.slice(describe.start, describe.end);
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const abs = describe.start + match.index;
    const brace = findCallbackBrace(source, abs + match[0].length);
    if (brace < 0) continue;
    const end = matchBrace(source, brace);
    if (end < 0) continue;
    slices.push(source.slice(abs, end + 1));
  }
  return slices;
}

function readSpecSource(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) return undefined;
  return fs.readFileSync(abs, "utf8");
}

function findTestBlock(blocks: SourceBlock[], failure: NormalizedFailure): SourceBlock | undefined {
  const tests = blocks.filter((b) => b.kind === "test" && b.title === failure.testTitle);
  if (tests.length === 1) return tests[0];
  if (tests.length > 1 && failure.errorLocation?.line) {
    const lineStarts = lineStartOffsets(readSpecSource(failure.filePath) ?? "");
    const offset = lineStarts[failure.errorLocation.line - 1];
    if (offset !== undefined) {
      const containing = tests.find((t) => t.start <= offset && offset <= t.end);
      if (containing) return containing;
    }
  }
  return tests[0];
}

function parseLoginCall(
  slice: string,
): { app?: string; usernameField: string; passwordField: string } | undefined {
  const perform = slice.match(
    /performLogin\s*\(\s*[^,]+,\s*['"](\w+)['"]\s*,\s*\{[^}]*username:\s*config\.(\w+)_credentials\.(\w+)[^}]*password:\s*config\.\w+_credentials\.(\w+)/,
  );
  if (perform) {
    return { app: perform[1], usernameField: perform[3], passwordField: perform[4] };
  }

  const login = slice.match(
    /\.login\s*\(\s*\{\s*username:\s*config\.(\w+)_credentials\.(\w+)\s*,\s*password:\s*config\.\w+_credentials\.(\w+)/,
  );
  if (login) {
    return { app: login[1], usernameField: login[2], passwordField: login[3] };
  }

  const userField = slice.match(/config\.(\w+)_credentials\.(\w*Username|username)\b/);
  if (!userField) return undefined;
  const usernameField = userField[2];
  const passwordField =
    usernameField === "username" ? "password" : usernameField.replace(/Username$/, "Password");
  return { app: userField[1], usernameField, passwordField };
}

function collectBlocks(source: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const re =
    /\btest((?:\.describe)?(?:\.(?:only|skip|fixme|serial))*)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const mods = match[1] ?? "";
    const kind: SourceBlock["kind"] = mods.includes(".describe") ? "describe" : "test";
    const brace = findCallbackBrace(source, match.index + match[0].length);
    if (brace < 0) continue;
    const end = matchBrace(source, brace);
    if (end < 0) continue;
    blocks.push({ kind, title: match[3], start: match.index, end });
  }
  return blocks;
}

function findCallbackBrace(source: string, from: number): number {
  const arrow = source.indexOf("=>", from);
  if (arrow < 0) return -1;
  let i = arrow + 2;
  while (i < source.length && /\s/.test(source[i])) i++;
  return source[i] === "{" ? i : -1;
}

function matchBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}
