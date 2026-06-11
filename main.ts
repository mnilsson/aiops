import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BASELINE_FIX_LABEL,
  BLOCKED_LABELS,
  IN_PROGRESS_LABEL,
  MAX_ISSUES_PER_RUN,
  PRIORITY_LABEL,
  loadProjects,
  type Forge,
  type SandcastleProject,
} from "./project-config.js";

const WORKSPACES_DIR = join(process.cwd(), ".aiops", "workspaces");
const PROMPT_DIR = resolve(process.cwd(), "prompts");
const SHELL_AGENT: sandcastle.AgentProvider = {
  name: "shell",
  env: {},
  captureSessions: false,
  buildPrintCommand(options) {
    return { command: "bash -s", stdin: options.prompt };
  },
  parseStreamLine(line) {
    return [{ type: "text", text: line }];
  },
};

const PI_THINKING_LEVEL = "medium";
const baseAgent = sandcastle.pi("openai-codex/gpt-5.5");
const AGENT: sandcastle.AgentProvider = {
  ...baseAgent,
  buildPrintCommand(options) {
    const command = baseAgent.buildPrintCommand(options);
    return {
      ...command,
      command: command.command.replace(
        "pi -p ",
        `pi -p --thinking ${PI_THINKING_LEVEL} --no-extensions --no-skills --no-prompt-templates --no-context-files `,
      ),
    };
  },
};

const projects = await loadProjects();

type GitLabIssue = {
  iid: number;
  title: string;
  description?: string;
  labels?: string[];
  created_at?: string;
  web_url?: string;
  state?: string;
  references?: { full: string };
};

type GitHubIssue = {
  number: number;
  title: string;
  body?: string;
  labels?: Array<string | { name?: string }>;
  createdAt?: string;
  url?: string;
  state?: string;
};

type TrackedIssue = {
  iid: number;
  title: string;
  description?: string;
  labels?: string[];
  created_at?: string;
  web_url?: string;
  state?: string;
  references?: { full: string };
};

type CandidateIssue = TrackedIssue & {
  repo: string;
  defaultBranch: string;
  risk: string;
  branch: string;
  project: SandcastleProject;
  forge: Forge;
};

type VerifyResult = {
  ok: boolean;
  output: string;
  skipped?: boolean;
};

type GitLabMergeRequest = {
  iid: number;
  title: string;
  source_branch: string;
  target_branch: string;
  project_id: number;
  state: string;
  draft?: boolean;
  labels?: string[];
  description?: string;
  web_url?: string;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
};

type GitLabPipeline = {
  id: number;
  status: string;
  web_url?: string;
};

type GitLabJob = {
  id: number;
  name: string;
  stage: string;
  status: string;
  failure_reason?: string;
  web_url?: string;
};

type GitHubPullRequest = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  headRefOid?: string;
  isCrossRepository?: boolean;
  isDraft?: boolean;
  labels?: Array<string | { name?: string }>;
  body?: string;
  state?: string;
  url?: string;
  mergeStateStatus?: string;
  mergeable?: string;
};

type GitHubCheck = {
  bucket?: string;
  completedAt?: string;
  description?: string;
  link?: string;
  name: string;
  startedAt?: string;
  state?: string;
  workflow?: string;
};

type GitHubRun = {
  conclusion?: string;
  databaseId: number;
  displayTitle?: string;
  event?: string;
  headBranch?: string;
  name?: string;
  status?: string;
  url?: string;
  workflowName?: string;
};

type FailedGitLabReviewRequest = {
  forge: "gitlab";
  project: SandcastleProject;
  mr: GitLabMergeRequest;
  pipeline?: GitLabPipeline;
};

type FailedGitHubReviewRequest = {
  forge: "github";
  project: SandcastleProject;
  pr: GitHubPullRequest;
  checks: GitHubCheck[];
  runs: GitHubRun[];
};

type FailedReviewRequest = FailedGitLabReviewRequest | FailedGitHubReviewRequest;

type SlicePlan = {
  title: string;
  body: string;
};

type PrdSliceIssue = CandidateIssue & {
  order: number;
};

type ReviewRequest = {
  forge: Forge;
  id: number;
  title: string;
  branch: string;
  targetBranch: string;
  state: string;
  draft: boolean;
  labels: string[];
  body: string;
  url?: string;
};

const SANDBOX_IMAGE = "sandcastle:aiops";
const AGENT_MR_LABEL = "agent-created";
const AGENT_CREATED_LABEL = AGENT_MR_LABEL;
const CI_FIX_LABEL = "agent-fix-ci";
const PRD_TO_ISSUES_LABEL = "agent-to-issues";
const PRD_IMPLEMENT_LABEL = "agent-implement-prd";
const PRD_IN_PROGRESS_LABEL = "agent-prd-in-progress";
const PRD_READY_FOR_REVIEW_LABEL = "agent-ready-for-review";
const AGENT_BLOCKED_LABEL = "agent-blocked";
const AGENT_APPROVED_LABEL = "agent-approved";
const AGENT_SLICE_LABEL = "agent-slice";
const AGENT_SLICE_IMPLEMENTED_LABEL = "agent-slice-implemented";
const MAX_PRD_SLICES = 12;
const PRD_PARENT_MARKER_NAME = "aiops-parent-prd";
const PRD_PARENT_MARKER = /<!--\s*aiops-parent-prd:\s*([^>]+?)\s*-->/i;
const PRD_SLICE_ORDER_MARKER = /<!--\s*aiops-slice-order:\s*(\d+)\s*-->/i;
const PRD_SLICES_START = "<!-- aiops-prd-slices-start -->";
const PRD_SLICES_END = "<!-- aiops-prd-slices-end -->";
const PRD_REVIEW_START = "<!-- aiops-prd-review-start -->";
const PRD_REVIEW_END = "<!-- aiops-prd-review-end -->";
const ELIGIBLE_CI_FIX_MR_LABELS = [AGENT_MR_LABEL, CI_FIX_LABEL];
const FAILED_GITHUB_CHECK_BUCKETS = new Set(["fail"]);
const FAILED_GITHUB_RUN_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const COLORS_ENABLED = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const color = {
  dim: (text: string) => COLORS_ENABLED ? `\x1b[2m${text}\x1b[0m` : text,
  green: (text: string) => COLORS_ENABLED ? `\x1b[32m${text}\x1b[0m` : text,
  red: (text: string) => COLORS_ENABLED ? `\x1b[31m${text}\x1b[0m` : text,
  yellow: (text: string) => COLORS_ENABLED ? `\x1b[33m${text}\x1b[0m` : text,
  cyan: (text: string) => COLORS_ENABLED ? `\x1b[36m${text}\x1b[0m` : text,
  bold: (text: string) => COLORS_ENABLED ? `\x1b[1m${text}\x1b[0m` : text,
};

function success(text: string): string {
  return color.green(text);
}

function failure(text: string): string {
  return color.red(text);
}

function heading(text: string): string {
  return color.bold(color.cyan(text));
}

function projectForge(project: SandcastleProject): Forge {
  return project.forge ?? "gitlab";
}

function forgeName(forge: Forge): string {
  return forge === "github" ? "GitHub" : "GitLab";
}

function githubConfigHostPath(): string | undefined {
  const candidates = [
    process.env.GH_CONFIG_DIR,
    join(homedir(), ".config", "gh"),
    join(homedir(), "Library", "Application Support", "gh"),
    join(homedir(), "Library", "Application Support", "github-cli"),
    join(homedir(), "Library", "Application Support", "GitHub CLI"),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate));
}

function sandboxProvider(project: SandcastleProject) {
  const mounts = [
    {
      hostPath: "~/.pi/agent",
      sandboxPath: "/mnt/host-pi-agent",
      readonly: true,
    },
  ];

  if (projectForge(project) === "github") {
    const ghConfig = githubConfigHostPath();
    if (ghConfig) {
      mounts.push({
        hostPath: ghConfig,
        sandboxPath: "~/.config/gh",
        readonly: true,
      });
    }
  } else {
    mounts.push({
      hostPath: "~/Library/Application Support/glab-cli",
      sandboxPath: "~/.config/glab-cli",
      readonly: true,
    });
  }

  return docker({
    imageName: project.sandboxImage ?? SANDBOX_IMAGE,
    mounts,
  });
}

function sh(command: string, options: { cwd?: string; allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(command, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: "/bin/bash",
    });
  } catch (error) {
    if (options.allowFailure) {
      const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
      return [
        `exit status: ${e.status ?? "unknown"}`,
        String(e.stdout ?? ""),
        String(e.stderr ?? ""),
      ].join("\n");
    }
    throw error;
  }
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(raw: string): T | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

function commandFailed(output: string): boolean {
  return output.includes("exit status:") && !output.includes("exit status: 0");
}

function renderPromptFile(path: string, args: Record<string, string>): string {
  const template = readFileSync(path, "utf8");
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => args[key] ?? "");
}

function runAgentPrompt(prompt: string, options: { cwd?: string } = {}): string {
  const command = AGENT.buildPrintCommand({ prompt, dangerouslySkipPermissions: false });
  const raw = execFileSync(command.command, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...AGENT.env },
    input: command.stdin,
    shell: "/bin/bash",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const text: string[] = [];
  const results: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    for (const event of AGENT.parseStreamLine(line)) {
      if (event.type === "text") text.push(event.text);
      else if (event.type === "result") results.push(event.result);
    }
  }
  return (results.at(-1) ?? text.join("") ?? raw).trim();
}

function parseTaggedJson<T>(raw: string, tag: string): T {
  const match = raw.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
  if (!match) throw new Error(`Agent output did not include <${tag}> JSON.`);
  return JSON.parse(match[1]!) as T;
}

function withTempFile<T>(contents: string, callback: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "aiops-"));
  const path = join(dir, "body.md");
  try {
    writeFileSync(path, contents);
    return callback(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function workspaceName(repo: string): string {
  return repo.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function ensureWorkspace(project: SandcastleProject): string {
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  const dir = join(WORKSPACES_DIR, workspaceName(project.repo));

  if (existsSync(join(dir, ".git"))) {
    sh(`git remote set-url origin ${project.remoteUrl}`, { cwd: dir });
    sh("git fetch --prune origin", { cwd: dir });
  } else {
    sh(`git clone ${project.remoteUrl} ${JSON.stringify(dir)}`);
  }

  sh(`git checkout ${project.defaultBranch}`, { cwd: dir });
  sh(`git reset --hard origin/${project.defaultBranch}`, { cwd: dir });
  sh("git clean -fd", { cwd: dir });
  sh("rm -rf .pi", { cwd: dir });
  return dir;
}

function toCandidateIssue(project: SandcastleProject, issue: TrackedIssue): CandidateIssue {
  return {
    ...issue,
    repo: project.repo,
    defaultBranch: project.defaultBranch,
    risk: project.risk,
    branch: `agent/${issue.iid}-${slugify(issue.title)}`,
    project,
    forge: projectForge(project),
  };
}

function githubLabelNames(labels: GitHubIssue["labels"] = []): string[] {
  return labels
    .map((label) => typeof label === "string" ? label : label.name)
    .filter((label): label is string => Boolean(label));
}

function listGitLabIssues(project: SandcastleProject): CandidateIssue[] {
  const args = [
    "issue list",
    `-R ${shellQuote(project.repo)}`,
    "--output json",
    "--per-page 100",
    ...project.requiredLabels.map((label) => `--label ${shellQuote(label)}`),
    `--not-label ${shellQuote(IN_PROGRESS_LABEL)}`,
  ];
  const raw = sh(`glab ${args.join(" ")}`);
  const issues = JSON.parse(raw) as GitLabIssue[];

  return issues
    .filter((issue) => !issue.labels?.includes(IN_PROGRESS_LABEL))
    .map((issue) => toCandidateIssue(project, issue));
}

function listGitHubIssues(project: SandcastleProject): CandidateIssue[] {
  const args = [
    "issue list",
    `-R ${shellQuote(project.repo)}`,
    "--state open",
    "--limit 100",
    "--json number,title,body,labels,createdAt,url,state",
    ...project.requiredLabels.map((label) => `--label ${shellQuote(label)}`),
  ];
  const raw = sh(`gh ${args.join(" ")}`);
  const issues = JSON.parse(raw) as GitHubIssue[];

  return issues
    .map((issue) => ({
      iid: issue.number,
      title: issue.title,
      description: issue.body,
      labels: githubLabelNames(issue.labels),
      created_at: issue.createdAt,
      web_url: issue.url,
      state: issue.state,
      references: { full: `${project.repo}#${issue.number}` },
    }))
    .filter((issue) => !issue.labels.includes(IN_PROGRESS_LABEL))
    .map((issue) => toCandidateIssue(project, issue));
}

function listIssues(project: SandcastleProject): CandidateIssue[] {
  return projectForge(project) === "github" ? listGitHubIssues(project) : listGitLabIssues(project);
}

function listGitLabIssuesWithLabel(project: SandcastleProject, label: string, options: { all?: boolean } = {}): CandidateIssue[] {
  const args = [
    "issue list",
    `-R ${shellQuote(project.repo)}`,
    "--output json",
    "--per-page 100",
    options.all ? "--all" : undefined,
    `--label ${shellQuote(label)}`,
  ].filter(Boolean);
  const raw = sh(`glab ${args.join(" ")}`);
  return (JSON.parse(raw) as GitLabIssue[]).map((issue) => toCandidateIssue(project, issue));
}

function listGitHubIssuesWithLabel(project: SandcastleProject, label: string, options: { all?: boolean } = {}): CandidateIssue[] {
  const raw = sh(
    `gh issue list -R ${shellQuote(project.repo)} --state ${options.all ? "all" : "open"} --limit 200 --label ${shellQuote(label)} --json number,title,body,labels,createdAt,url,state`,
  );
  return (JSON.parse(raw) as GitHubIssue[]).map((issue) =>
    toCandidateIssue(project, {
      iid: issue.number,
      title: issue.title,
      description: issue.body,
      labels: githubLabelNames(issue.labels),
      created_at: issue.createdAt,
      web_url: issue.url,
      state: issue.state,
      references: { full: `${project.repo}#${issue.number}` },
    })
  );
}

function listIssuesWithLabel(project: SandcastleProject, label: string, options: { all?: boolean } = {}): CandidateIssue[] {
  return projectForge(project) === "github"
    ? listGitHubIssuesWithLabel(project, label, options)
    : listGitLabIssuesWithLabel(project, label, options);
}

function getIssue(project: SandcastleProject, iid: number): CandidateIssue {
  if (projectForge(project) === "github") {
    const raw = sh(`gh issue view ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --json number,title,body,labels,createdAt,url,state`);
    const issue = JSON.parse(raw) as GitHubIssue;
    return toCandidateIssue(project, {
      iid: issue.number,
      title: issue.title,
      description: issue.body,
      labels: githubLabelNames(issue.labels),
      created_at: issue.createdAt,
      web_url: issue.url,
      state: issue.state,
      references: { full: `${project.repo}#${issue.number}` },
    });
  }

  const raw = sh(`glab issue view ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --output json`);
  return toCandidateIssue(project, JSON.parse(raw) as GitLabIssue);
}

function issueRef(project: SandcastleProject, iid: number): string {
  return `${project.repo}#${iid}`;
}

function isOpenIssue(issue: TrackedIssue): boolean {
  const state = (issue.state ?? "open").toLowerCase();
  return state === "open" || state === "opened";
}

function rankIssues(issues: CandidateIssue[]): CandidateIssue[] {
  return [...issues].sort((a, b) => {
    const aCritical = a.labels?.includes(PRIORITY_LABEL) ? 1 : 0;
    const bCritical = b.labels?.includes(PRIORITY_LABEL) ? 1 : 0;
    if (aCritical !== bCritical) return bCritical - aCritical;
    return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  });
}

function runCommands(commands: string[], cwd: string): VerifyResult {
  if (commands.length === 0) return { ok: true, output: "No verify commands configured." };

  const parts: string[] = [];
  let ok = true;
  for (const command of commands) {
    parts.push(`$ ${command}`);
    const output = sh(command, { cwd, allowFailure: true });
    parts.push(output.trim());
    if (output.includes("exit status:") && !output.includes("exit status: 0")) ok = false;
  }
  return { ok, output: parts.join("\n\n") };
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function sandboxCommand(project: SandcastleProject, options: { includeSetup: boolean; marker: string }): string {
  const setupLines = options.includeSetup ? project.setupCommands.map((command) => `run_step "setup" ${shellQuote(command)}`) : [];
  const verifyLines = project.verifyCommands.length > 0
    ? project.verifyCommands.map((command) => `run_step "verify" ${shellQuote(command)}`)
    : ['echo "No verify commands configured."'];

  return [
    "set +e",
    "ok=1",
    "run_step() {",
    "  kind=\"$1\"",
    "  command=\"$2\"",
    "  echo \"$ $command\"",
    "  output=$(bash -lc \"$command\" 2>&1)",
    "  status=$?",
    "  if [ $status -ne 0 ]; then ok=0; echo \"exit status: $status\"; fi",
    "  printf '%s\\n\\n' \"$output\"",
    "}",
    ...setupLines,
    ...verifyLines,
    `echo ${options.marker}=$ok`,
  ].join("\n");
}

function sandboxBaselineCommand(project: SandcastleProject): string {
  return sandboxCommand(project, { includeSetup: true, marker: "__SANDCASTLE_BASELINE_STATUS__" });
}

function sandboxVerifyCommand(project: SandcastleProject): string {
  return sandboxCommand(project, { includeSetup: false, marker: "__SANDCASTLE_VERIFY_STATUS__" });
}

async function runSandboxBaseline(project: SandcastleProject, cwd: string): Promise<VerifyResult> {
  const sandbox = await sandcastle.createSandbox({
    cwd,
    branch: `sandcastle/baseline-${workspaceName(project.repo)}`,
    baseBranch: project.defaultBranch,
    sandbox: sandboxProvider(project),
  });

  try {
    const result = await sandbox.run({
      name: `${workspaceName(project.repo)}-baseline`,
      agent: SHELL_AGENT,
      prompt: sandboxBaselineCommand(project),
      maxIterations: 1,
    });
    const ok = /__SANDCASTLE_BASELINE_STATUS__=1\b/.test(result.stdout);
    const output = result.stdout.replace(/__SANDCASTLE_BASELINE_STATUS__=\d+\s*$/, "").trim();
    return { ok, output: output || "Baseline did not produce output." };
  } finally {
    await sandbox.close();
  }
}

async function runSandboxVerify(project: SandcastleProject, sandbox: sandcastle.Sandbox, name: string): Promise<VerifyResult> {
  const result = await sandbox.run({
    name,
    agent: SHELL_AGENT,
    prompt: sandboxVerifyCommand(project),
    maxIterations: 1,
  });
  const ok = /__SANDCASTLE_VERIFY_STATUS__=1\b/.test(result.stdout);
  const output = result.stdout.replace(/__SANDCASTLE_VERIFY_STATUS__=\d+\s*$/, "").trim();
  return { ok, output: output || "Verification did not produce output." };
}

function issueCanRunWithBaseline(issue: CandidateIssue, baseline: VerifyResult): boolean {
  if (baseline.skipped) return false;
  if (baseline.ok) return true;
  if (issue.labels?.includes(BASELINE_FIX_LABEL)) return true;
  return /\b(ci|test|tests|build|baseline|pipeline|phpunit|typecheck)\b/i.test(issue.title);
}

function extractBlockedByRefs(issue: CandidateIssue): string[] {
  const description = (issue.description ?? "").replace(/\\n/g, "\n");
  const section = description.match(/(?:^|\n)##\s*Blocked by\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] ?? "";
  const refs = new Set<string>();
  const issueRefPattern = /(?:(?<repo>[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+))?#(?<iid>\d+)/g;

  for (const match of section.matchAll(issueRefPattern)) {
    const repo = match.groups?.repo ?? issue.repo;
    const iid = match.groups?.iid;
    if (iid) refs.add(`${repo}#${iid}`);
  }

  return [...refs].filter(Boolean);
}

const issueResolvedCache = new Map<string, boolean>();

function splitIssueRef(ref: string): { repo: string; iid: string } | undefined {
  const index = ref.lastIndexOf("#");
  if (index < 1 || index === ref.length - 1) return undefined;
  return { repo: ref.slice(0, index), iid: ref.slice(index + 1) };
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label;
      if (label && typeof label === "object" && "name" in label) return (label as { name?: unknown }).name;
      return undefined;
    })
    .filter((label): label is string => typeof label === "string" && label.length > 0);
}

function issueRefIsResolved(ref: string, forge: Forge): boolean {
  const cacheKey = `${forge}:${ref}`;
  const cached = issueResolvedCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parsed = splitIssueRef(ref);
  if (!parsed) return false;

  const command = forge === "github"
    ? `gh issue view ${shellQuote(parsed.iid)} -R ${shellQuote(parsed.repo)} --json state,labels`
    : `glab issue view ${shellQuote(parsed.iid)} -R ${shellQuote(parsed.repo)} --output json`;
  const raw = sh(command, { allowFailure: true });
  try {
    const issue = JSON.parse(raw) as { state?: string; labels?: unknown };
    const state = (issue.state ?? "unknown").toLowerCase();
    const resolved = state === "closed" || labelNames(issue.labels).includes(AGENT_SLICE_IMPLEMENTED_LABEL);
    issueResolvedCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    issueResolvedCache.set(cacheKey, false);
    return false;
  }
}

function issueIsBlocked(issue: CandidateIssue): boolean {
  const blockedLabels = issue.labels?.filter((label) => BLOCKED_LABELS.includes(label)) ?? [];
  if (blockedLabels.length > 0) {
    console.log(color.yellow(`- ${issue.repo}#${issue.iid}: skipped due to blocked label(s): ${blockedLabels.join(", ")}`));
    return true;
  }

  const blockers = extractBlockedByRefs(issue);
  const openBlockers = blockers.filter((ref) => !issueRefIsResolved(ref, issue.forge));
  if (openBlockers.length > 0) {
    console.log(color.yellow(`- ${issue.repo}#${issue.iid}: blocked by ${openBlockers.join(", ")}`));
    return true;
  }
  return false;
}

function hasLabel(issue: { labels?: string[] }, label: string): boolean {
  return issue.labels?.includes(label) ?? false;
}

function prdWorkflowEnabled(project: SandcastleProject): boolean {
  return project.prdWorkflow !== false;
}

function isSliceIssue(issue: { description?: string }): boolean {
  return PRD_PARENT_MARKER.test(issue.description ?? "");
}

function parentRef(project: SandcastleProject, parentIid: number): string {
  return issueRef(project, parentIid);
}

function parentMarker(project: SandcastleProject, parentIid: number): string {
  return `<!-- ${PRD_PARENT_MARKER_NAME}: ${parentRef(project, parentIid)} -->`;
}

function parseParentRef(body?: string): string | undefined {
  return body?.match(PRD_PARENT_MARKER)?.[1]?.trim();
}

function parseSliceOrder(body?: string): number | undefined {
  const raw = body?.match(PRD_SLICE_ORDER_MARKER)?.[1];
  if (!raw) return undefined;
  const order = Number.parseInt(raw, 10);
  return Number.isInteger(order) && order > 0 ? order : undefined;
}

function formatSliceOrder(order: number): string {
  return String(order).padStart(2, "0");
}

function prdBranchName(parent: CandidateIssue): string {
  return `agent/prd-${parent.iid}-${slugify(parent.title)}`;
}

function parentPrdEligible(parent: CandidateIssue, triggerLabel: string): boolean {
  if (!prdWorkflowEnabled(parent.project)) return false;
  if (!hasLabel(parent, triggerLabel)) return false;
  if (hasLabel(parent, AGENT_BLOCKED_LABEL)) return false;
  if (parent.risk === "high" && !hasLabel(parent, AGENT_APPROVED_LABEL)) return false;
  if (isSliceIssue(parent)) return false;
  return !issueIsBlocked(parent);
}

function replaceMachineSection(body: string, start: string, end: string, replacement: string): string {
  const startIndex = body.indexOf(start);
  const endIndex = body.indexOf(end);
  if ((startIndex === -1) !== (endIndex === -1) || (startIndex !== -1 && endIndex < startIndex)) {
    throw new Error(`Found mismatched machine-owned markers ${start} / ${end}.`);
  }
  const normalizedReplacement = replacement.trim();
  if (startIndex === -1) return [body.trimEnd(), normalizedReplacement].filter(Boolean).join("\n\n") + "\n";
  return `${body.slice(0, startIndex).trimEnd()}\n\n${normalizedReplacement}\n\n${body.slice(endIndex + end.length).trimStart()}`.trimEnd() + "\n";
}

function updateIssueBody(project: SandcastleProject, iid: number, body: string): void {
  withTempFile(body, (path) => {
    if (projectForge(project) === "github") {
      sh(`gh issue edit ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --body-file ${shellQuote(path)}`);
    } else {
      sh(`glab api projects/${gitlabProjectPath(project.repo)}/issues/${iid} -X PUT -F ${shellQuote(`description=@${path}`)} --silent`);
    }
  });
}

function addIssueLabels(project: SandcastleProject, iid: number, labels: string[]): void {
  if (labels.length === 0) return;
  const joined = labels.join(",");
  const command = projectForge(project) === "github"
    ? `gh issue edit ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --add-label ${shellQuote(joined)}`
    : `glab issue update ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --label ${shellQuote(joined)}`;
  sh(command);
}

function removeIssueLabels(project: SandcastleProject, iid: number, labels: string[]): void {
  if (labels.length === 0) return;
  const joined = labels.join(",");
  const command = projectForge(project) === "github"
    ? `gh issue edit ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --remove-label ${shellQuote(joined)}`
    : `glab issue update ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --unlabel ${shellQuote(joined)}`;
  sh(command, { allowFailure: true });
}

function addIssueComment(project: SandcastleProject, iid: number, body: string): void {
  withTempFile(body, (path) => {
    if (projectForge(project) === "github") {
      sh(`gh issue comment ${shellQuote(String(iid))} -R ${shellQuote(project.repo)} --body-file ${shellQuote(path)}`);
    } else {
      sh(`glab api projects/${gitlabProjectPath(project.repo)}/issues/${iid}/notes -X POST -F ${shellQuote(`body=@${path}`)} --silent`);
    }
  });
}

function createIssue(project: SandcastleProject, title: string, body: string, labels: string[]): CandidateIssue {
  if (projectForge(project) === "github") {
    const labelArgs = labels.map((label) => `--label ${shellQuote(label)}`).join(" ");
    const url = withTempFile(body, (path) => sh(`gh issue create -R ${shellQuote(project.repo)} --title ${shellQuote(title)} --body-file ${shellQuote(path)} ${labelArgs}`)).trim();
    const iid = Number.parseInt(url.match(/\/issues\/(\d+)/)?.[1] ?? "", 10);
    if (!Number.isInteger(iid)) throw new Error(`Could not parse created GitHub issue URL: ${url}`);
    return getIssue(project, iid);
  }

  const raw = withTempFile(body, (path) =>
    sh(
      `glab api projects/${gitlabProjectPath(project.repo)}/issues -X POST -f ${shellQuote(`title=${title}`)} -F ${shellQuote(`description=@${path}`)} -f ${shellQuote(`labels=${labels.join(",")}`)}`,
    )
  );
  return toCandidateIssue(project, JSON.parse(raw) as GitLabIssue);
}

function listPrdSlices(project: SandcastleProject, parent: CandidateIssue): PrdSliceIssue[] {
  const expectedParent = parentRef(project, parent.iid);
  return listIssuesWithLabel(project, AGENT_SLICE_LABEL, { all: true })
    .map((issue) => issue.description === undefined ? getIssue(project, issue.iid) : issue)
    .filter((issue) => parseParentRef(issue.description) === expectedParent)
    .map((issue) => ({ ...issue, order: parseSliceOrder(issue.description) ?? 0 }))
    .filter((issue): issue is PrdSliceIssue => issue.order > 0)
    .sort((a, b) => a.order - b.order || a.iid - b.iid);
}

function listInvalidPrdSlices(project: SandcastleProject, parent: CandidateIssue): CandidateIssue[] {
  const expectedParent = parentRef(project, parent.iid);
  return listIssuesWithLabel(project, AGENT_SLICE_LABEL, { all: true })
    .map((issue) => issue.description === undefined ? getIssue(project, issue.iid) : issue)
    .filter((issue) => parseParentRef(issue.description) === expectedParent)
    .filter((issue) => parseSliceOrder(issue.description) === undefined);
}

function buildParentSliceSection(slices: PrdSliceIssue[]): string {
  const lines = slices.map((slice) => {
    const done = hasLabel(slice, AGENT_SLICE_IMPLEMENTED_LABEL) || !isOpenIssue(slice);
    return `- [${done ? "x" : " "}] #${slice.iid} — ${slice.title}`;
  });
  return [PRD_SLICES_START, "## aiops slices", "", ...lines, PRD_SLICES_END].join("\n");
}

function updateParentSliceChecklist(project: SandcastleProject, parent: CandidateIssue, slices: PrdSliceIssue[]): void {
  const freshParent = getIssue(project, parent.iid);
  const body = replaceMachineSection(freshParent.description ?? "", PRD_SLICES_START, PRD_SLICES_END, buildParentSliceSection(slices));
  updateIssueBody(project, parent.iid, body);
}

function blockPrdWorkflow(project: SandcastleProject, parent: CandidateIssue, message: string, options: { slice?: CandidateIssue; removeLabels?: string[]; labelSlice?: boolean } = {}): void {
  try {
    addIssueLabels(project, parent.iid, [AGENT_BLOCKED_LABEL]);
  } catch (error) {
    console.error(failure(`Could not add ${AGENT_BLOCKED_LABEL} to ${project.repo}#${parent.iid}:`), error);
  }
  if (options.removeLabels?.length) removeIssueLabels(project, parent.iid, options.removeLabels);
  try {
    addIssueComment(project, parent.iid, message);
  } catch (error) {
    console.error(failure(`Could not comment on ${project.repo}#${parent.iid}:`), error);
  }
  if (options.slice) {
    if (options.labelSlice) {
      try {
        addIssueLabels(project, options.slice.iid, [AGENT_BLOCKED_LABEL]);
      } catch (error) {
        console.error(failure(`Could not add ${AGENT_BLOCKED_LABEL} to ${project.repo}#${options.slice.iid}:`), error);
      }
    }
    try {
      addIssueComment(project, options.slice.iid, message);
    } catch (error) {
      console.error(failure(`Could not comment on ${project.repo}#${options.slice.iid}:`), error);
    }
  }
}

function sliceBody(project: SandcastleProject, parent: CandidateIssue, order: number, body: string): string {
  return [
    `Parent PRD: #${parent.iid}`,
    "",
    parentMarker(project, parent.iid),
    `<!-- aiops-slice-order: ${formatSliceOrder(order)} -->`,
    "",
    body.trim(),
    "",
  ].join("\n");
}

function commandList(commands: string[]): string {
  return commands.length ? commands.map((c) => `- \`${c}\``).join("\n") : "- No commands configured.";
}

function issueViewCommand(issue: CandidateIssue): string {
  return issue.forge === "github"
    ? `gh issue view ${shellQuote(String(issue.iid))} -R ${shellQuote(issue.repo)} --comments`
    : `glab issue view ${shellQuote(String(issue.iid))} -R ${shellQuote(issue.repo)} --comments`;
}

function issuePromptArgs(issue: CandidateIssue, baseline: VerifyResult): Record<string, string> {
  return {
    REPO: issue.repo,
    GITLAB_REPO: issue.repo,
    GITHUB_REPO: issue.repo,
    ISSUE_TRACKER: forgeName(issue.forge),
    ISSUE_ID: String(issue.iid),
    TASK_ID: String(issue.iid),
    ISSUE_TITLE: issue.title,
    ISSUE_VIEW_COMMAND: issueViewCommand(issue),
    BRANCH: issue.branch,
    MR_TARGET_BRANCH: issue.defaultBranch,
    SETUP_COMMANDS: commandList(issue.project.setupCommands),
    VERIFY_COMMANDS: commandList(issue.project.verifyCommands),
    BASELINE_OK: String(baseline.ok),
    BASELINE_OUTPUT: baseline.output.slice(-12000),
  };
}

function reviewRequestPromptFile(issue: CandidateIssue): string {
  return join(PROMPT_DIR, issue.forge === "github" ? "pr-prompt.md" : "mr-prompt.md");
}

function addReviewRequestLabel(issue: CandidateIssue): void {
  const command = issue.forge === "github"
    ? `gh pr edit ${shellQuote(issue.branch)} -R ${shellQuote(issue.repo)} --add-label ${shellQuote(AGENT_MR_LABEL)}`
    : `glab mr update ${shellQuote(issue.branch)} -R ${shellQuote(issue.repo)} --label ${shellQuote(AGENT_MR_LABEL)}`;
  sh(command, { allowFailure: true });
}

function sandboxHooks(project: SandcastleProject) {
  return {
    sandbox: {
      onSandboxReady: [
        {
          command:
            "mkdir -p ~/.pi/agent && cp -a /mnt/host-pi-agent/. ~/.pi/agent/ && chmod -R u+rwX ~/.pi/agent",
        },
        {
          command:
            "mkdir -p ~/.pi/agent/state && printf '%s\n' '{' '  \"enabled\": false,' '  \"service_tier\": \"default\"' '}' > ~/.pi/agent/state/codex-fast-mode.json",
        },
        ...project.setupCommands.map((command) => ({ command })),
      ],
    },
  };
}

function listOpenMergeRequests(project: SandcastleProject): GitLabMergeRequest[] {
  const raw = sh(`glab mr list -R ${shellQuote(project.repo)} --output json --per-page 100`);
  return JSON.parse(raw) as GitLabMergeRequest[];
}

function listOpenPullRequests(project: SandcastleProject): GitHubPullRequest[] {
  const raw = sh(
    `gh pr list -R ${shellQuote(project.repo)} --state open --limit 100 --json number,title,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,labels,body,state,url,mergeStateStatus,mergeable`,
  );
  return JSON.parse(raw) as GitHubPullRequest[];
}

function gitlabReviewRequest(project: SandcastleProject, mr: GitLabMergeRequest): ReviewRequest {
  return {
    forge: "gitlab",
    id: mr.iid,
    title: mr.title,
    branch: mr.source_branch,
    targetBranch: mr.target_branch,
    state: mr.state,
    draft: mr.draft === true || /^draft:/i.test(mr.title),
    labels: mr.labels ?? [],
    body: mr.description ?? "",
    url: mr.web_url,
  };
}

function githubReviewRequest(pr: GitHubPullRequest): ReviewRequest {
  return {
    forge: "github",
    id: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    targetBranch: pr.baseRefName,
    state: pr.state ?? "OPEN",
    draft: pr.isDraft === true,
    labels: githubLabelNames(pr.labels),
    body: pr.body ?? "",
    url: pr.url,
  };
}

function getGitHubPullRequest(project: SandcastleProject, number: number): GitHubPullRequest | undefined {
  const raw = sh(
    `gh pr view ${shellQuote(String(number))} -R ${shellQuote(project.repo)} --json number,title,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,labels,body,state,url,mergeStateStatus,mergeable`,
    { allowFailure: true },
  );
  return parseJsonObject<GitHubPullRequest>(raw);
}

function listPrdReviewRequests(project: SandcastleProject, parent: CandidateIssue, branch: string): ReviewRequest[] {
  const expectedParent = parentRef(project, parent.iid);
  if (projectForge(project) === "github") {
    const raw = sh(
      `gh pr list -R ${shellQuote(project.repo)} --state all --limit 100 --head ${shellQuote(branch)} --json number,title,headRefName,baseRefName,isDraft,labels,body,state,url`,
    );
    return parseJsonArray<GitHubPullRequest>(raw)
      .map(githubReviewRequest)
      .filter((pr) => pr.branch === branch && parseParentRef(pr.body) === expectedParent);
  }

  const raw = sh(`glab mr list -R ${shellQuote(project.repo)} --all --source-branch ${shellQuote(branch)} --output json --per-page 100`);
  return parseJsonArray<GitLabMergeRequest>(raw)
    .map((mr) => getMergeRequest(project, mr.iid) ?? mr)
    .map((mr) => gitlabReviewRequest(project, mr))
    .filter((mr) => mr.branch === branch && parseParentRef(mr.body) === expectedParent);
}

function selectPrdReviewRequest(project: SandcastleProject, parent: CandidateIssue, branch: string): ReviewRequest | undefined {
  const matches = listPrdReviewRequests(project, parent, branch);
  const open = matches.filter((rr) => ["open", "opened"].includes(rr.state.toLowerCase()));
  if (open.length > 1) throw new Error(`Multiple open PRD review requests found for ${parent.repo}#${parent.iid} on ${branch}.`);
  if (open.length === 1) return open[0];
  const closed = matches.find((rr) => ["closed"].includes(rr.state.toLowerCase()));
  if (closed) throw new Error(`Previous PRD review request ${closed.url ?? closed.id} was closed without merge.`);
  const merged = matches.find((rr) => ["merged"].includes(rr.state.toLowerCase()));
  if (merged) throw new Error(`Previous PRD review request ${merged.url ?? merged.id} was already merged; human recovery is required before continuing.`);
  return undefined;
}

function buildPrdReviewSection(project: SandcastleProject, parent: CandidateIssue, slices: PrdSliceIssue[], verify: VerifyResult): string {
  const implemented = slices.filter((slice) => hasLabel(slice, AGENT_SLICE_IMPLEMENTED_LABEL)).length;
  const sliceLines = slices.map((slice) => {
    const done = hasLabel(slice, AGENT_SLICE_IMPLEMENTED_LABEL);
    return `- [${done ? "x" : " "}] Closes #${slice.iid} — ${slice.title}`;
  });
  return [
    PRD_REVIEW_START,
    parentMarker(project, parent.iid),
    "## aiops PRD",
    "",
    `Parent PRD: Closes #${parent.iid}`,
    `Status: ${implemented}/${slices.length} slices implemented`,
    "",
    "Slices:",
    ...sliceLines,
    "",
    "## Latest verification",
    "",
    "```text",
    `ok: ${verify.ok}`,
    verify.output.slice(-12000),
    "```",
    PRD_REVIEW_END,
  ].join("\n");
}

function buildPrdReviewBody(existingBody: string | undefined, project: SandcastleProject, parent: CandidateIssue, slices: PrdSliceIssue[], verify: VerifyResult): string {
  return replaceMachineSection(existingBody ?? "", PRD_REVIEW_START, PRD_REVIEW_END, buildPrdReviewSection(project, parent, slices, verify));
}

function addReviewRequestLabels(project: SandcastleProject, rr: ReviewRequest, labels: string[]): void {
  if (labels.length === 0) return;
  const joined = labels.join(",");
  const command = rr.forge === "github"
    ? `gh pr edit ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)} --add-label ${shellQuote(joined)}`
    : `glab mr update ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)} --label ${shellQuote(joined)}`;
  sh(command);
}

function updateReviewRequestBody(project: SandcastleProject, rr: ReviewRequest, body: string): void {
  withTempFile(body, (path) => {
    if (rr.forge === "github") {
      sh(`gh pr edit ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)} --body-file ${shellQuote(path)}`);
    } else {
      sh(`glab api projects/${gitlabProjectPath(project.repo)}/merge_requests/${rr.id} -X PUT -F ${shellQuote(`description=@${path}`)} --silent`);
    }
  });
}

function createPrdReviewRequest(project: SandcastleProject, parent: CandidateIssue, branch: string, slices: PrdSliceIssue[], verify: VerifyResult): ReviewRequest {
  const title = `PRD #${parent.iid}: ${parent.title}`;
  const body = buildPrdReviewBody("", project, parent, slices, verify);
  if (projectForge(project) === "github") {
    const url = withTempFile(body, (path) =>
      sh(
        `gh pr create -R ${shellQuote(project.repo)} --draft --base ${shellQuote(project.defaultBranch)} --head ${shellQuote(branch)} --title ${shellQuote(title)} --body-file ${shellQuote(path)} --label ${shellQuote(AGENT_CREATED_LABEL)} --label ${shellQuote(PRD_IN_PROGRESS_LABEL)}`,
      )
    ).trim();
    const number = Number.parseInt(url.match(/\/pull\/(\d+)/)?.[1] ?? "", 10);
    if (!Number.isInteger(number)) throw new Error(`Could not parse created GitHub PR URL: ${url}`);
    const pr = getGitHubPullRequest(project, number);
    if (!pr) throw new Error(`Created GitHub PR ${number}, but could not read it back.`);
    return githubReviewRequest(pr);
  }

  const draftTitle = /^draft:/i.test(title) ? title : `Draft: ${title}`;
  const raw = withTempFile(body, (path) =>
    sh(
      `glab api projects/${gitlabProjectPath(project.repo)}/merge_requests -X POST -f ${shellQuote(`source_branch=${branch}`)} -f ${shellQuote(`target_branch=${project.defaultBranch}`)} -f ${shellQuote(`title=${draftTitle}`)} -F ${shellQuote(`description=@${path}`)} -f ${shellQuote(`labels=${[AGENT_CREATED_LABEL, PRD_IN_PROGRESS_LABEL].join(",")}`)}`,
    )
  );
  const created = gitlabReviewRequest(project, JSON.parse(raw) as GitLabMergeRequest);
  if (!created.draft) markReviewRequestDraft(project, created);
  return gitlabReviewRequest(project, getMergeRequest(project, created.id) ?? JSON.parse(raw) as GitLabMergeRequest);
}

function markReviewRequestDraft(project: SandcastleProject, rr: ReviewRequest): void {
  if (rr.forge === "github") {
    sh(`gh pr ready ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)} --undo`, { allowFailure: true });
  } else {
    const output = sh(`glab mr update ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)} --draft`, { allowFailure: true });
    const refreshed = commandFailed(output) ? undefined : getMergeRequest(project, rr.id);
    if (!refreshed || !gitlabReviewRequest(project, refreshed).draft) {
      const title = /^draft:/i.test(rr.title) ? rr.title : `Draft: ${rr.title}`;
      sh(`glab mr update ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)} --title ${shellQuote(title)}`);
    }
  }
}

function upsertPrdReviewRequest(project: SandcastleProject, parent: CandidateIssue, branch: string, slices: PrdSliceIssue[], verify: VerifyResult): ReviewRequest {
  const existing = selectPrdReviewRequest(project, parent, branch);
  if (!existing) return createPrdReviewRequest(project, parent, branch, slices, verify);
  const body = buildPrdReviewBody(existing.body, project, parent, slices, verify);
  updateReviewRequestBody(project, existing, body);
  addReviewRequestLabels(project, existing, [AGENT_CREATED_LABEL, PRD_IN_PROGRESS_LABEL]);
  if (!allSlicesImplemented(slices)) markReviewRequestDraft(project, existing);
  return { ...existing, body };
}

function markReviewRequestReady(project: SandcastleProject, rr: ReviewRequest): void {
  if (rr.forge === "github") {
    sh(`gh pr ready ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)}`, { allowFailure: true });
  } else {
    sh(`glab mr update ${shellQuote(String(rr.id))} -R ${shellQuote(project.repo)} --ready`, { allowFailure: true });
  }
  addReviewRequestLabels(project, rr, [PRD_READY_FOR_REVIEW_LABEL]);
}

function githubPrChecks(project: SandcastleProject, prNumber: number): GitHubCheck[] {
  const raw = sh(
    `gh pr checks ${shellQuote(String(prNumber))} -R ${shellQuote(project.repo)} --json bucket,completedAt,description,link,name,startedAt,state,workflow 2>/dev/null || true`,
  );
  return parseJsonArray<GitHubCheck>(raw);
}

function githubRunsForHead(project: SandcastleProject, headRefOid?: string): GitHubRun[] {
  if (!headRefOid) return [];
  const raw = sh(
    `gh run list -R ${shellQuote(project.repo)} --commit ${shellQuote(headRefOid)} --limit 20 --json conclusion,databaseId,displayTitle,event,headBranch,name,status,url,workflowName 2>/dev/null || true`,
  );
  return parseJsonArray<GitHubRun>(raw);
}

function failedGithubChecks(checks: GitHubCheck[]): GitHubCheck[] {
  return checks.filter((check) => FAILED_GITHUB_CHECK_BUCKETS.has((check.bucket ?? "").toLowerCase()));
}

function failedGithubRuns(runs: GitHubRun[]): GitHubRun[] {
  return runs.filter((run) => FAILED_GITHUB_RUN_CONCLUSIONS.has((run.conclusion ?? "").toLowerCase()));
}

function githubRunTrace(project: SandcastleProject, runId: number): string {
  return sh(`gh run view ${shellQuote(String(runId))} -R ${shellQuote(project.repo)} --log-failed 2>&1 || true`).split("\n").slice(-240).join("\n");
}

function prHasConflicts(pr: GitHubPullRequest): boolean {
  return pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
}

function latestMrPipeline(mr: GitLabMergeRequest): GitLabPipeline | undefined {
  const raw = sh(`glab api projects/${mr.project_id}/merge_requests/${mr.iid}/pipelines`, { allowFailure: true });
  try {
    return (JSON.parse(raw) as GitLabPipeline[])[0];
  } catch {
    return undefined;
  }
}

function getMergeRequest(project: SandcastleProject, iid: number): GitLabMergeRequest | undefined {
  const raw = sh(`glab api projects/${gitlabProjectPath(project.repo)}/merge_requests/${iid}`, { allowFailure: true });
  try {
    return JSON.parse(raw) as GitLabMergeRequest;
  } catch {
    return undefined;
  }
}

function mrHasConflicts(mr: GitLabMergeRequest): boolean {
  return mr.has_conflicts === true || [mr.detailed_merge_status, mr.merge_status].includes("conflict");
}

function gitlabProjectPath(repo: string): string {
  return encodeURIComponent(repo);
}

function latestBranchPipeline(project: SandcastleProject): GitLabPipeline | undefined {
  const raw = sh(
    `glab api "projects/${gitlabProjectPath(project.repo)}/pipelines?ref=${encodeURIComponent(project.defaultBranch)}&per_page=1"`,
    { allowFailure: true },
  );
  try {
    return (JSON.parse(raw) as GitLabPipeline[])[0];
  } catch {
    return undefined;
  }
}

function pipelineJobs(project: SandcastleProject, pipelineId: number): GitLabJob[] {
  const raw = sh(`glab api projects/${gitlabProjectPath(project.repo)}/pipelines/${pipelineId}/jobs`, { allowFailure: true });
  try {
    return JSON.parse(raw) as GitLabJob[];
  } catch {
    return [];
  }
}

const IN_PROGRESS_CI_STATUSES = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"]);
const PASSING_BASELINE_JOB_STATUSES = new Set(["success", "skipped", "manual"]);

function gitlabQualityBaseline(project: SandcastleProject): VerifyResult {
  const pipeline = latestBranchPipeline(project);
  if (!pipeline) return { ok: false, output: `No GitLab pipeline found for ${project.repo}@${project.defaultBranch}.` };

  const jobs = pipelineJobs(project, pipeline.id).filter((job) => job.stage === "quality");
  const summary = jobs.map((job) => `${job.stage}/${job.name}: ${job.status} ${job.failure_reason ?? ""}\n${job.web_url ?? ""}`).join("\n\n");
  const details = [`GitLab quality baseline from ${project.repo}@${project.defaultBranch}`, `pipeline: ${pipeline.status} ${pipeline.web_url ?? pipeline.id}`];
  if (summary) details.push(summary);

  const inProgressJobs = jobs.filter((job) => IN_PROGRESS_CI_STATUSES.has(job.status));
  if (inProgressJobs.length > 0 || (jobs.length === 0 && IN_PROGRESS_CI_STATUSES.has(pipeline.status))) {
    return {
      ok: false,
      skipped: true,
      output: [...details, "Quality baseline is still running; project skipped for this run."].join("\n\n"),
    };
  }

  if (jobs.length === 0) {
    return { ok: true, output: `Pipeline ${pipeline.id} has no quality-stage jobs. ${pipeline.web_url ?? ""}`.trim() };
  }

  const failed = jobs.filter((job) => !PASSING_BASELINE_JOB_STATUSES.has(job.status));
  return {
    ok: failed.length === 0,
    output: details.join("\n\n"),
  };
}

function failedPipelineJobs(projectId: number, pipelineId: number): GitLabJob[] {
  const raw = sh(`glab api projects/${projectId}/pipelines/${pipelineId}/jobs`, { allowFailure: true });
  try {
    return (JSON.parse(raw) as GitLabJob[]).filter((job) => job.status === "failed");
  } catch {
    return [];
  }
}

function jobTrace(projectId: number, jobId: number): string {
  return sh(`glab api projects/${projectId}/jobs/${jobId}/trace`, { allowFailure: true }).split("\n").slice(-240).join("\n");
}

function conflictSummary(project: SandcastleProject, mr: GitLabMergeRequest, cwd: string): string {
  sh(`git fetch origin ${JSON.stringify(mr.target_branch)} ${JSON.stringify(mr.source_branch)}`, { cwd, allowFailure: true });
  sh(`git checkout ${JSON.stringify(mr.source_branch)}`, { cwd, allowFailure: true });
  sh(`git reset --hard ${JSON.stringify(`origin/${mr.source_branch}`)}`, { cwd, allowFailure: true });
  sh("git clean -fd", { cwd, allowFailure: true });
  sh(`git merge --no-commit --no-ff ${JSON.stringify(`origin/${mr.target_branch}`)}`, { cwd, allowFailure: true });
  const status = sh("git status --short", { cwd, allowFailure: true });
  const conflicts = sh("git diff --name-only --diff-filter=U", { cwd, allowFailure: true });
  sh("git merge --abort", { cwd, allowFailure: true });
  sh(`git checkout ${JSON.stringify(project.defaultBranch)}`, { cwd, allowFailure: true });
  sh(`git reset --hard ${JSON.stringify(`origin/${project.defaultBranch}`)}`, { cwd, allowFailure: true });
  sh("git clean -fd", { cwd, allowFailure: true });
  return [`Conflict check for ${project.repo}!${mr.iid}`, status.trim(), conflicts.trim() ? `Conflicted files:\n${conflicts.trim()}` : "No conflicted files reported by git."].join("\n\n");
}

function githubConflictSummary(project: SandcastleProject, pr: GitHubPullRequest, cwd: string): string {
  sh(`git fetch origin ${JSON.stringify(pr.baseRefName)} ${JSON.stringify(`pull/${pr.number}/head:${pr.headRefName}`)}`, { cwd, allowFailure: true });
  sh(`git checkout ${JSON.stringify(pr.headRefName)}`, { cwd, allowFailure: true });
  sh(`git reset --hard ${JSON.stringify(pr.headRefName)}`, { cwd, allowFailure: true });
  sh("git clean -fd", { cwd, allowFailure: true });
  sh(`git merge --no-commit --no-ff ${JSON.stringify(`origin/${pr.baseRefName}`)}`, { cwd, allowFailure: true });
  const status = sh("git status --short", { cwd, allowFailure: true });
  const conflicts = sh("git diff --name-only --diff-filter=U", { cwd, allowFailure: true });
  sh("git merge --abort", { cwd, allowFailure: true });
  sh(`git checkout ${JSON.stringify(project.defaultBranch)}`, { cwd, allowFailure: true });
  sh(`git reset --hard ${JSON.stringify(`origin/${project.defaultBranch}`)}`, { cwd, allowFailure: true });
  sh("git clean -fd", { cwd, allowFailure: true });
  return [`Conflict check for ${project.repo}#${pr.number}`, status.trim(), conflicts.trim() ? `Conflicted files:\n${conflicts.trim()}` : "No conflicted files reported by git."].join("\n\n");
}

function ensureLocalBranchFromRemote(cwd: string, branch: string): void {
  const existsRemote = sh(`git ls-remote --exit-code --heads origin ${shellQuote(branch)}`, { cwd, allowFailure: true });
  if (commandFailed(existsRemote)) return;
  sh(`git fetch origin ${shellQuote(`${branch}:refs/remotes/origin/${branch}`)}`, { cwd, allowFailure: true });
  const existsLocal = sh(`git show-ref --verify --quiet refs/heads/${shellQuote(branch)}`, { cwd, allowFailure: true });
  if (commandFailed(existsLocal)) sh(`git branch ${shellQuote(branch)} ${shellQuote(`origin/${branch}`)}`, { cwd, allowFailure: true });
}

function mergeTargetIntoBranch(project: SandcastleProject, cwd: string): VerifyResult {
  sh(`git fetch origin ${shellQuote(project.defaultBranch)}`, { cwd, allowFailure: true });
  const output = sh(`git merge --no-edit ${shellQuote(`origin/${project.defaultBranch}`)}`, { cwd, allowFailure: true });
  if (!commandFailed(output)) return { ok: true, output };
  const status = sh("git status --short", { cwd, allowFailure: true });
  const conflicts = sh("git diff --name-only --diff-filter=U", { cwd, allowFailure: true });
  sh("git merge --abort", { cwd, allowFailure: true });
  return {
    ok: false,
    output: [`Could not merge origin/${project.defaultBranch} into PRD branch.`, output.trim(), status.trim(), conflicts.trim() ? `Conflicted files:\n${conflicts.trim()}` : undefined].filter(Boolean).join("\n\n"),
  };
}

function mergeRemoteBranchIntoBranch(cwd: string, branch: string): VerifyResult {
  sh(`git fetch origin ${shellQuote(`${branch}:refs/remotes/origin/${branch}`)}`, { cwd, allowFailure: true });
  const remoteExists = sh(`git rev-parse --verify --quiet ${shellQuote(`origin/${branch}`)}`, { cwd, allowFailure: true });
  if (commandFailed(remoteExists)) return { ok: true, output: `No remote branch origin/${branch} found.` };
  const output = sh(`git merge --no-edit ${shellQuote(`origin/${branch}`)}`, { cwd, allowFailure: true });
  if (!commandFailed(output)) return { ok: true, output };
  const status = sh("git status --short", { cwd, allowFailure: true });
  const conflicts = sh("git diff --name-only --diff-filter=U", { cwd, allowFailure: true });
  sh("git merge --abort", { cwd, allowFailure: true });
  return {
    ok: false,
    output: [`Could not merge origin/${branch} into local PRD branch.`, output.trim(), status.trim(), conflicts.trim() ? `Conflicted files:\n${conflicts.trim()}` : undefined].filter(Boolean).join("\n\n"),
  };
}

function pushBranch(cwd: string, branch: string): VerifyResult {
  const first = sh(`git push origin HEAD:${shellQuote(branch)}`, { cwd, allowFailure: true });
  if (!commandFailed(first)) return { ok: true, output: first };

  sh(`git fetch origin ${shellQuote(`${branch}:refs/remotes/origin/${branch}`)}`, { cwd, allowFailure: true });
  const merge = sh(`git merge --no-edit ${shellQuote(`origin/${branch}`)}`, { cwd, allowFailure: true });
  if (commandFailed(merge)) {
    const conflicts = sh("git diff --name-only --diff-filter=U", { cwd, allowFailure: true });
    sh("git merge --abort", { cwd, allowFailure: true });
    return { ok: false, output: [`Initial push failed. Remote branch merge also failed.`, first.trim(), merge.trim(), conflicts.trim()].filter(Boolean).join("\n\n") };
  }

  const retry = sh(`git push origin HEAD:${shellQuote(branch)}`, { cwd, allowFailure: true });
  return commandFailed(retry)
    ? { ok: false, output: [`Initial push failed. Retry after merging remote branch also failed.`, first.trim(), retry.trim()].join("\n\n") }
    : { ok: true, output: [first.trim(), merge.trim(), retry.trim()].filter(Boolean).join("\n\n") };
}

function uniqueProjects(selectedProjects: SandcastleProject[]): SandcastleProject[] {
  const seen = new Set<string>();
  return selectedProjects.filter((project) => {
    if (seen.has(project.repo)) return false;
    seen.add(project.repo);
    return true;
  });
}

function prepareWorkspaces(selectedProjects: SandcastleProject[] = projects) {
  const projectsToPrepare = uniqueProjects(selectedProjects);
  console.log(heading("Preparing managed workspaces..."));
  const workspaces = new Map<string, string>();
  for (const project of projectsToPrepare) workspaces.set(project.repo, ensureWorkspace(project));
  return workspaces;
}

async function prepareWorkspacesAndBaselines(selectedProjects: SandcastleProject[]) {
  const projectsToPrepare = uniqueProjects(selectedProjects);
  const workspaces = prepareWorkspaces(projectsToPrepare);
  const baselines = new Map<string, VerifyResult>();

  for (const project of projectsToPrepare) {
    const dir = workspaces.get(project.repo)!;

    const baselineMode = project.baselineMode ?? "local";
    console.log(`- ${color.cyan(project.repo)}: ${baselineMode === "gitlab-quality" ? "GitLab quality" : "sandbox"} baseline verification`);
    const baseline = baselineMode === "gitlab-quality" && projectForge(project) !== "gitlab"
      ? { ok: false, skipped: true, output: "gitlab-quality baseline mode is only supported for GitLab projects." }
      : baselineMode === "gitlab-quality"
        ? gitlabQualityBaseline(project)
        : await runSandboxBaseline(project, dir);
    baselines.set(project.repo, baseline);
    const baselineStatus = baseline.skipped ? color.yellow("skipped") : baseline.ok ? success("green") : failure("red");
    console.log(`  ${baselineStatus}`);
    if (baseline.skipped || !baseline.ok) {
      console.log(color.yellow(baseline.skipped ? "  skip reason:" : "  baseline output:"));
      console.log(color.dim(baseline.output.split("\n").map((line) => `    ${line}`).join("\n")));
    }
  }

  return { workspaces, baselines };
}

async function runIssues() {
  const validIssues = rankIssues(projects.flatMap(listIssues))
    .map((issue) => issue.description === undefined ? getIssue(issue.project, issue.iid) : issue)
    .filter((issue) => {
      if (isSliceIssue(issue)) {
        console.log(color.yellow(`- ${issue.repo}#${issue.iid}: skipped Slice Issue; use PRD workflow`));
        return false;
      }
      return true;
    })
    .filter((issue) => !issueIsBlocked(issue));
  const projectsWithValidIssues = uniqueProjects(validIssues.map((issue) => issue.project));
  const { workspaces, baselines } = await prepareWorkspacesAndBaselines(projectsWithValidIssues);
  const candidates = validIssues
    .filter((issue) => issueCanRunWithBaseline(issue, baselines.get(issue.repo)!))
    .slice(0, MAX_ISSUES_PER_RUN);

  console.log(`\n${heading(`Selected ${candidates.length} issue(s):`)}`);
  for (const issue of candidates) console.log(`- ${color.cyan(`${issue.repo}#${issue.iid}`)}: ${issue.title} ${color.dim("->")} ${color.yellow(issue.branch)}`);

  const settled = await Promise.allSettled(
    candidates.map(async (issue) => {
      const workspace = workspaces.get(issue.repo)!;
      const baseline = baselines.get(issue.repo)!;
      const sandbox = await sandcastle.createSandbox({
        cwd: workspace,
        branch: issue.branch,
        baseBranch: issue.defaultBranch,
        sandbox: sandboxProvider(issue.project),
        hooks: sandboxHooks(issue.project),
      });

      try {
        const commonArgs = issuePromptArgs(issue, baseline);

        const implement = await sandbox.run({
          name: `${workspaceName(issue.repo)}-${issue.iid}-implementer`,
          maxIterations: 100,
          idleTimeoutSeconds: 1800,
          agent: AGENT,
          promptFile: join(PROMPT_DIR, "implement-prompt.md"),
          promptArgs: commonArgs,
        });

        if (implement.commits.length === 0) return { issue, commits: [] };

        const review = await sandbox.run({
          name: `${workspaceName(issue.repo)}-${issue.iid}-reviewer`,
          maxIterations: 1,
          idleTimeoutSeconds: 1800,
          agent: AGENT,
          promptFile: join(PROMPT_DIR, "review-prompt.md"),
          promptArgs: commonArgs,
        });

        const reviewRequest = await sandbox.run({
          name: `${workspaceName(issue.repo)}-${issue.iid}-${issue.forge === "github" ? "pr" : "mr"}-opener`,
          maxIterations: 1,
          idleTimeoutSeconds: 1800,
          agent: AGENT,
          promptFile: reviewRequestPromptFile(issue),
          promptArgs: commonArgs,
        });

        addReviewRequestLabel(issue);

        return { issue, commits: [...implement.commits, ...review.commits, ...reviewRequest.commits] };
      } finally {
        await sandbox.close();
      }
    }),
  );

  for (const [i, outcome] of settled.entries()) {
    const issue = candidates[i]!;
    if (outcome.status === "rejected") console.error(failure(`✗ ${issue.repo}#${issue.iid} failed:`), outcome.reason);
    else console.log(success(`✓ ${issue.repo}#${issue.iid}: ${outcome.value.commits.length} commit(s)`));
  }
}

function validateSlicePlans(parent: CandidateIssue, value: unknown): SlicePlan[] {
  const slices = (value as { slices?: unknown }).slices;
  if (!Array.isArray(slices)) throw new Error("Slice output must contain a slices array.");
  if (slices.length === 0) throw new Error("Slice output must contain at least one slice.");
  if (slices.length > MAX_PRD_SLICES) throw new Error(`Slice output contains ${slices.length} slices; max is ${MAX_PRD_SLICES}.`);

  return slices.map((slice, index) => {
    const item = slice as Partial<SlicePlan>;
    const title = String(item.title ?? "").trim();
    const body = String(item.body ?? "").trim();
    if (!title) throw new Error(`Slice ${index + 1} has no title.`);
    if (title.length + 4 > 100) throw new Error(`Slice ${index + 1} title is too long.`);
    if (!body) throw new Error(`Slice ${index + 1} has no body.`);
    const normalizedTitle = title.toLowerCase();
    if (normalizedTitle === parent.title.trim().toLowerCase() || /\b(do everything|whole prd|entire prd)\b/i.test(`${title}\n${body}`)) {
      throw new Error(`Slice ${index + 1} is too broad: ${title}`);
    }
    return { title, body };
  });
}

function generateSlicePlans(parent: CandidateIssue): SlicePlan[] {
  const prompt = renderPromptFile(join(PROMPT_DIR, "to-issues-prd-prompt.md"), {
    REPO: parent.repo,
    ISSUE_TRACKER: forgeName(parent.forge),
    PARENT_PRD_ID: String(parent.iid),
    PARENT_PRD_TITLE: parent.title,
    PARENT_PRD_VIEW_COMMAND: issueViewCommand(parent),
    MAX_SLICES: String(MAX_PRD_SLICES),
  });
  const output = runAgentPrompt(prompt);
  const parsed = parseTaggedJson<unknown>(output, "slices");
  return validateSlicePlans(parent, parsed);
}

async function runToIssuesPrd() {
  const candidates = rankIssues(
    projects
      .filter(prdWorkflowEnabled)
      .flatMap((project) => listIssuesWithLabel(project, PRD_TO_ISSUES_LABEL))
      .map((issue) => getIssue(issue.project, issue.iid)),
  )
    .filter((parent) => parentPrdEligible(parent, PRD_TO_ISSUES_LABEL))
    .slice(0, MAX_ISSUES_PER_RUN);

  console.log(`\n${heading(`Selected ${candidates.length} Parent PRD(s) for slicing:`)}`);
  for (const parent of candidates) console.log(`- ${color.cyan(`${parent.repo}#${parent.iid}`)}: ${parent.title}`);

  for (const parent of candidates) {
    try {
      const invalid = listInvalidPrdSlices(parent.project, parent);
      const existing = listPrdSlices(parent.project, parent);
      if (invalid.length > 0) {
        const warning = `aiops found ${invalid.length} Slice Issue(s) with invalid aiops slice-order markers. Fix or remove them before rerunning decomposition.`;
        if (existing.length === 0) {
          blockPrdWorkflow(parent.project, parent, warning, { removeLabels: [PRD_TO_ISSUES_LABEL] });
          console.log(color.yellow(`- ${parent.repo}#${parent.iid}: blocked due to invalid existing Slice Issue markers`));
          continue;
        }
        addIssueComment(parent.project, parent.iid, warning);
      }

      if (existing.length > 0) {
        updateParentSliceChecklist(parent.project, parent, existing);
        removeIssueLabels(parent.project, parent.iid, [PRD_TO_ISSUES_LABEL]);
        addIssueComment(parent.project, parent.iid, `aiops found existing Slice Issues for this Parent PRD and reused them instead of creating duplicates. Refreshed the slice checklist.`);
        console.log(success(`✓ ${parent.repo}#${parent.iid}: reused ${existing.length} existing slice(s)`));
        continue;
      }

      const plans = generateSlicePlans(parent);
      for (const [index, plan] of plans.entries()) {
        const order = index + 1;
        createIssue(
          parent.project,
          `${formatSliceOrder(order)}: ${plan.title}`,
          sliceBody(parent.project, parent, order, plan.body),
          [AGENT_SLICE_LABEL, AGENT_CREATED_LABEL],
        );
      }

      const slices = listPrdSlices(parent.project, parent);
      updateParentSliceChecklist(parent.project, parent, slices);
      removeIssueLabels(parent.project, parent.iid, [PRD_TO_ISSUES_LABEL]);
      addIssueComment(parent.project, parent.iid, `aiops created ${slices.length} Slice Issue(s). Add \`${PRD_IMPLEMENT_LABEL}\` when you want implementation to start.`);
      console.log(success(`✓ ${parent.repo}#${parent.iid}: created ${slices.length} slice(s)`));
    } catch (error) {
      const message = `aiops could not decompose this Parent PRD into Slice Issues.\n\n\`\`\`text\n${String(error instanceof Error ? error.stack ?? error.message : error).slice(-12000)}\n\`\`\``;
      blockPrdWorkflow(parent.project, parent, message, { removeLabels: [PRD_TO_ISSUES_LABEL] });
      console.error(failure(`✗ ${parent.repo}#${parent.iid} slicing failed:`), error);
    }
  }
}

function sliceListSummary(slices: PrdSliceIssue[]): string {
  return slices
    .map((slice) => {
      const state = hasLabel(slice, AGENT_SLICE_IMPLEMENTED_LABEL) ? "implemented" : isOpenIssue(slice) ? "open" : "closed";
      return `- ${formatSliceOrder(slice.order)} #${slice.iid} ${state}: ${slice.title}`;
    })
    .join("\n");
}

function prdSlicePromptArgs(parent: CandidateIssue, slice: PrdSliceIssue, branch: string, slices: PrdSliceIssue[], baseline: VerifyResult, reviewRequest?: ReviewRequest): Record<string, string> {
  return {
    REPO: parent.repo,
    GITLAB_REPO: parent.repo,
    GITHUB_REPO: parent.repo,
    ISSUE_TRACKER: forgeName(parent.forge),
    PARENT_PRD_ID: String(parent.iid),
    PARENT_PRD_TITLE: parent.title,
    PARENT_PRD_VIEW_COMMAND: issueViewCommand(parent),
    SLICE_ISSUE_ID: String(slice.iid),
    SLICE_ISSUE_TITLE: slice.title,
    SLICE_ISSUE_VIEW_COMMAND: issueViewCommand(slice),
    SLICE_LIST: sliceListSummary(slices),
    REVIEW_REQUEST_URL: reviewRequest?.url ?? "No shared Review Request exists yet.",
    BRANCH: branch,
    MR_TARGET_BRANCH: parent.defaultBranch,
    SETUP_COMMANDS: commandList(parent.project.setupCommands),
    VERIFY_COMMANDS: commandList(parent.project.verifyCommands),
    BASELINE_OK: String(baseline.ok),
    BASELINE_OUTPUT: baseline.output.slice(-12000),
  };
}

function firstPendingSlice(slices: PrdSliceIssue[]): PrdSliceIssue | undefined {
  return slices.find((slice) => isOpenIssue(slice) && !hasLabel(slice, AGENT_SLICE_IMPLEMENTED_LABEL));
}

function allSlicesImplemented(slices: PrdSliceIssue[]): boolean {
  return slices.length > 0 && slices.every((slice) => hasLabel(slice, AGENT_SLICE_IMPLEMENTED_LABEL));
}

function prdCanRunWithBaseline(parent: CandidateIssue, slice: CandidateIssue, baseline: VerifyResult): boolean {
  return issueCanRunWithBaseline(parent, baseline) || issueCanRunWithBaseline(slice, baseline);
}

async function markPrdReadyIfComplete(project: SandcastleProject, parent: CandidateIssue, branch: string, slices: PrdSliceIssue[], verify: VerifyResult): Promise<boolean> {
  if (!allSlicesImplemented(slices)) return false;
  const rr = selectPrdReviewRequest(project, parent, branch);
  if (!rr) throw new Error(`All slices are implemented, but no shared Review Request exists for ${branch}.`);
  const body = buildPrdReviewBody(rr.body, project, parent, slices, verify);
  updateReviewRequestBody(project, rr, body);
  markReviewRequestReady(project, rr);
  removeIssueLabels(project, parent.iid, [PRD_IMPLEMENT_LABEL]);
  addIssueLabels(project, parent.iid, [PRD_IN_PROGRESS_LABEL, PRD_READY_FOR_REVIEW_LABEL]);
  addIssueComment(project, parent.iid, `All Slice Issues are implemented in ${rr.url ?? `review request ${rr.id}`}. The Review Request is ready for human review.`);
  return true;
}

async function implementParentPrd(parent: CandidateIssue, workspace: string, baseline: VerifyResult): Promise<{ parent: CandidateIssue; commits: number }> {
  const project = parent.project;
  const branch = prdBranchName(parent);
  let totalCommits = 0;
  let warnedInvalidSlices = false;

  for (let iteration = 1; iteration <= MAX_PRD_SLICES; iteration++) {
    let slices = listPrdSlices(project, parent);
    const invalid = listInvalidPrdSlices(project, parent);
    if (invalid.length > 0 && !warnedInvalidSlices) {
      warnedInvalidSlices = true;
      addIssueComment(project, parent.iid, `aiops found ${invalid.length} Slice Issue(s) with invalid aiops slice-order markers. They were ignored.`);
    }
    if (slices.length === 0) throw new Error(`No Slice Issues found. Run ${PRD_TO_ISSUES_LABEL} first.`);

    if (await markPrdReadyIfComplete(project, parent, branch, slices, { ok: true, output: "All Slice Issues were already marked implemented." })) {
      return { parent, commits: totalCommits };
    }

    const slice = firstPendingSlice(slices);
    if (!slice) return { parent, commits: totalCommits };

    console.log(color.cyan(`- ${parent.repo}#${parent.iid}: implementing Slice Issue #${slice.iid} (${formatSliceOrder(slice.order)})`));

    if (hasLabel(slice, AGENT_BLOCKED_LABEL) || issueIsBlocked(slice)) {
      blockPrdWorkflow(project, parent, `aiops paused this PRD Workflow at Slice Issue #${slice.iid} because that slice is blocked.`, {
        slice,
        removeLabels: [PRD_IMPLEMENT_LABEL],
        labelSlice: true,
      });
      return { parent, commits: totalCommits };
    }

    if (baseline.skipped) {
      console.log(color.yellow(`- ${parent.repo}#${parent.iid}: skipped because baseline verification is not ready`));
      return { parent, commits: totalCommits };
    }

    if (!prdCanRunWithBaseline(parent, slice, baseline)) {
      blockPrdWorkflow(project, parent, `aiops paused this PRD Workflow because baseline verification is failing and neither the Parent PRD nor current Slice Issue is labelled \`${BASELINE_FIX_LABEL}\` or clearly about CI/test/build repair.\n\n\`\`\`text\n${baseline.output.slice(-12000)}\n\`\`\``, {
        slice,
        removeLabels: [PRD_IMPLEMENT_LABEL],
      });
      return { parent, commits: totalCommits };
    }

    ensureLocalBranchFromRemote(workspace, branch);
    const sandbox = await sandcastle.createSandbox({
      cwd: workspace,
      branch,
      baseBranch: parent.defaultBranch,
      sandbox: sandboxProvider(project),
      hooks: sandboxHooks(project),
    });

    try {
      const mergeRemote = mergeRemoteBranchIntoBranch(sandbox.worktreePath, branch);
      if (!mergeRemote.ok) {
        blockPrdWorkflow(project, parent, `aiops could not safely merge the remote PRD branch before implementing Slice Issue #${slice.iid}.\n\n\`\`\`text\n${mergeRemote.output.slice(-12000)}\n\`\`\``, { slice, removeLabels: [PRD_IMPLEMENT_LABEL] });
        return { parent, commits: totalCommits };
      }

      const mergeTarget = mergeTargetIntoBranch(project, sandbox.worktreePath);
      if (!mergeTarget.ok) {
        blockPrdWorkflow(project, parent, `aiops could not merge the latest target branch before implementing Slice Issue #${slice.iid}.\n\n\`\`\`text\n${mergeTarget.output.slice(-12000)}\n\`\`\``, { slice, removeLabels: [PRD_IMPLEMENT_LABEL] });
        return { parent, commits: totalCommits };
      }

      const existingReviewRequest = selectPrdReviewRequest(project, parent, branch);
      const promptArgs = prdSlicePromptArgs(parent, slice, branch, slices, baseline, existingReviewRequest);
      const implement = await sandbox.run({
        name: `${workspaceName(parent.repo)}-prd-${parent.iid}-slice-${formatSliceOrder(slice.order)}-implementer`,
        maxIterations: 100,
        idleTimeoutSeconds: 1800,
        agent: AGENT,
        promptFile: join(PROMPT_DIR, "implement-prd-slice-prompt.md"),
        promptArgs,
      });

      if (implement.commits.length === 0) {
        blockPrdWorkflow(project, parent, `aiops made no commits for Slice Issue #${slice.iid}; human review is needed before continuing.`, { slice, removeLabels: [PRD_IMPLEMENT_LABEL] });
        return { parent, commits: totalCommits };
      }

      const review = await sandbox.run({
        name: `${workspaceName(parent.repo)}-prd-${parent.iid}-slice-${formatSliceOrder(slice.order)}-reviewer`,
        maxIterations: 1,
        idleTimeoutSeconds: 1800,
        agent: AGENT,
        promptFile: join(PROMPT_DIR, "review-prd-slice-prompt.md"),
        promptArgs,
      });
      const sliceCommits = implement.commits.length + review.commits.length;

      const verify = await runSandboxVerify(project, sandbox, `${workspaceName(parent.repo)}-prd-${parent.iid}-slice-${formatSliceOrder(slice.order)}-verify`);
      if (!verify.ok) {
        totalCommits += sliceCommits;
        blockPrdWorkflow(project, parent, `aiops verification failed after implementing Slice Issue #${slice.iid}. The branch was preserved for inspection.\n\n\`\`\`text\n${verify.output.slice(-12000)}\n\`\`\``, { slice, removeLabels: [PRD_IMPLEMENT_LABEL] });
        return { parent, commits: totalCommits };
      }

      const push = pushBranch(sandbox.worktreePath, branch);
      if (!push.ok) {
        totalCommits += sliceCommits;
        blockPrdWorkflow(project, parent, `aiops committed changes for Slice Issue #${slice.iid}, but pushing/updating the PRD branch failed.\n\n\`\`\`text\n${push.output.slice(-12000)}\n\`\`\``, { slice, removeLabels: [PRD_IMPLEMENT_LABEL] });
        return { parent, commits: totalCommits };
      }

      let reviewRequest: ReviewRequest;
      try {
        reviewRequest = upsertPrdReviewRequest(project, parent, branch, slices, verify);
      } catch (error) {
        totalCommits += sliceCommits;
        blockPrdWorkflow(project, parent, `aiops pushed changes for Slice Issue #${slice.iid}, but could not create/update the shared Review Request.\n\n\`\`\`text\n${String(error instanceof Error ? error.stack ?? error.message : error).slice(-12000)}\n\`\`\``, { slice, removeLabels: [PRD_IMPLEMENT_LABEL] });
        return { parent, commits: totalCommits };
      }

      addIssueLabels(project, slice.iid, [AGENT_SLICE_IMPLEMENTED_LABEL]);
      addIssueComment(project, slice.iid, `Implemented in ${reviewRequest.url ?? `review request ${reviewRequest.id}`}.`);
      addIssueLabels(project, parent.iid, [PRD_IN_PROGRESS_LABEL]);
      slices = listPrdSlices(project, parent);
      updateParentSliceChecklist(project, parent, slices);
      const refreshedBody = buildPrdReviewBody(reviewRequest.body, project, parent, slices, verify);
      updateReviewRequestBody(project, reviewRequest, refreshedBody);
      totalCommits += sliceCommits;

      if (allSlicesImplemented(slices)) {
        markReviewRequestReady(project, reviewRequest);
        removeIssueLabels(project, parent.iid, [PRD_IMPLEMENT_LABEL]);
        addIssueLabels(project, parent.iid, [PRD_READY_FOR_REVIEW_LABEL]);
        addIssueComment(project, parent.iid, `All Slice Issues are implemented in ${reviewRequest.url ?? `review request ${reviewRequest.id}`}. The Review Request is ready for human review.`);
        return { parent, commits: totalCommits };
      }

      addIssueComment(project, parent.iid, `Implemented Slice Issue #${slice.iid} in ${reviewRequest.url ?? `review request ${reviewRequest.id}`}. Continuing with the next Slice Issue while valid candidates remain.`);
    } finally {
      await sandbox.close();
    }
  }

  blockPrdWorkflow(project, parent, `aiops stopped this PRD Workflow after ${MAX_PRD_SLICES} implementation iteration(s) while Slice Issues still appear to be pending. Human review is needed before continuing.`, { removeLabels: [PRD_IMPLEMENT_LABEL] });
  return { parent, commits: totalCommits };
}

async function runImplementPrd() {
  const parents = rankIssues(
    projects
      .filter(prdWorkflowEnabled)
      .flatMap((project) => listIssuesWithLabel(project, PRD_IMPLEMENT_LABEL))
      .map((issue) => getIssue(issue.project, issue.iid)),
  )
    .filter((parent) => parentPrdEligible(parent, PRD_IMPLEMENT_LABEL))
    .slice(0, MAX_ISSUES_PER_RUN);

  const { workspaces, baselines } = await prepareWorkspacesAndBaselines(uniqueProjects(parents.map((parent) => parent.project)));

  console.log(`\n${heading(`Selected ${parents.length} Parent PRD(s) for implementation:`)}`);
  for (const parent of parents) console.log(`- ${color.cyan(`${parent.repo}#${parent.iid}`)}: ${parent.title} ${color.dim("->")} ${color.yellow(prdBranchName(parent))}`);

  const settled = await Promise.allSettled(
    parents.map((parent) => implementParentPrd(parent, workspaces.get(parent.repo)!, baselines.get(parent.repo)!)),
  );

  for (const [i, outcome] of settled.entries()) {
    const parent = parents[i]!;
    if (outcome.status === "rejected") {
      blockPrdWorkflow(parent.project, parent, `aiops failed while implementing this PRD Workflow.\n\n\`\`\`text\n${String(outcome.reason instanceof Error ? outcome.reason.stack ?? outcome.reason.message : outcome.reason).slice(-12000)}\n\`\`\``, { removeLabels: [PRD_IMPLEMENT_LABEL] });
      console.error(failure(`✗ ${parent.repo}#${parent.iid} failed:`), outcome.reason);
    } else {
      console.log(success(`✓ ${parent.repo}#${parent.iid}: ${outcome.value.commits} commit(s)`));
    }
  }
}

function listFailedGitLabReviewRequests(selectedProjects: SandcastleProject[]): FailedGitLabReviewRequest[] {
  return selectedProjects.flatMap((project) =>
    listOpenMergeRequests(project)
      .map((mr) => getMergeRequest(project, mr.iid) ?? mr)
      .filter((mr) => !mr.draft)
      .filter((mr) => ELIGIBLE_CI_FIX_MR_LABELS.some((label) => mr.labels?.includes(label)))
      .map((mr) => ({ forge: "gitlab" as const, project, mr, pipeline: latestMrPipeline(mr) }))
      .filter((item) => item.pipeline?.status === "failed" || mrHasConflicts(item.mr)),
  );
}

function listFailedGitHubReviewRequests(selectedProjects: SandcastleProject[]): FailedGitHubReviewRequest[] {
  return selectedProjects.flatMap((project) =>
    listOpenPullRequests(project)
      .filter((pr) => !pr.isDraft)
      .filter((pr) => !pr.isCrossRepository)
      .filter((pr) => ELIGIBLE_CI_FIX_MR_LABELS.some((label) => githubLabelNames(pr.labels).includes(label)))
      .map((pr) => ({
        forge: "github" as const,
        project,
        pr,
        checks: githubPrChecks(project, pr.number),
        runs: githubRunsForHead(project, pr.headRefOid),
      }))
      .filter((item) => failedGithubChecks(item.checks).length > 0 || failedGithubRuns(item.runs).length > 0 || prHasConflicts(item.pr)),
  );
}

function githubFailedCheckSummary(checks: GitHubCheck[]): string {
  return failedGithubChecks(checks)
    .map((check) => [
      `${check.workflow ? `${check.workflow}/` : ""}${check.name}: ${check.state ?? check.bucket ?? "failed"}`,
      check.description,
      check.link,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function githubFailedRunSummary(runs: GitHubRun[]): string {
  return failedGithubRuns(runs)
    .map((run) => [
      `${run.workflowName ?? run.name ?? run.displayTitle ?? `run ${run.databaseId}`}: ${run.status ?? ""} ${run.conclusion ?? ""}`.trim(),
      run.url,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function reviewRequestRef(item: FailedReviewRequest): string {
  return item.forge === "gitlab" ? `${item.project.repo}!${item.mr.iid}` : `${item.project.repo}#${item.pr.number}`;
}

function reviewRequestTitle(item: FailedReviewRequest): string {
  return item.forge === "gitlab" ? item.mr.title : item.pr.title;
}

function reviewRequestReasons(item: FailedReviewRequest): string {
  if (item.forge === "gitlab") {
    return [
      item.pipeline?.status === "failed" ? `failed pipeline ${item.pipeline.web_url ?? item.pipeline.id}` : undefined,
      mrHasConflicts(item.mr) ? "merge conflicts" : undefined,
    ].filter(Boolean).join(", ");
  }

  return [
    failedGithubChecks(item.checks).length > 0 ? `${failedGithubChecks(item.checks).length} failed check(s)` : undefined,
    failedGithubRuns(item.runs).length > 0 ? `${failedGithubRuns(item.runs).length} failed workflow run(s)` : undefined,
    prHasConflicts(item.pr) ? "merge conflicts" : undefined,
  ].filter(Boolean).join(", ");
}

async function fixGitLabReviewRequest(item: FailedGitLabReviewRequest, workspaces: Map<string, string>) {
  const { project, mr, pipeline } = item;
  const workspace = workspaces.get(project.repo)!;
  sh(`git fetch origin ${JSON.stringify(mr.source_branch)}:${JSON.stringify(mr.source_branch)}`, { cwd: workspace, allowFailure: true });
  const jobs = pipeline ? failedPipelineJobs(mr.project_id, pipeline.id) : [];
  const failedJobs = jobs.map((job) => `${job.stage}/${job.name}: ${job.status} ${job.failure_reason ?? ""}\n${job.web_url ?? ""}`).join("\n\n");
  const logs = jobs.map((job) => `===== ${job.stage}/${job.name} (${job.id}) =====\n${jobTrace(mr.project_id, job.id)}`).join("\n\n").slice(-24000);
  const conflicts = mrHasConflicts(mr) ? conflictSummary(project, mr, workspace).slice(-12000) : "MR is not currently reported as conflicted.";

  const sandbox = await sandcastle.createSandbox({
    cwd: workspace,
    branch: mr.source_branch,
    baseBranch: mr.target_branch,
    sandbox: sandboxProvider(project),
    hooks: sandboxHooks(project),
  });

  try {
    const result = await sandbox.run({
      name: `${workspaceName(project.repo)}-mr-${mr.iid}-ci-fixer`,
      maxIterations: 60,
      idleTimeoutSeconds: 1800,
      agent: AGENT,
      promptFile: join(PROMPT_DIR, "ci-fix-prompt.md"),
      promptArgs: {
        GITLAB_REPO: project.repo,
        MR_IID: String(mr.iid),
        MR_TITLE: mr.title,
        BRANCH: mr.source_branch,
        MR_TARGET_BRANCH: mr.target_branch,
        PIPELINE_URL: pipeline?.web_url ?? (pipeline ? String(pipeline.id) : "No MR pipeline found."),
        FAILED_JOBS: failedJobs || "No failed jobs found in pipeline API.",
        JOB_LOGS: logs || "No job logs found.",
        CONFLICT_SUMMARY: conflicts,
        SETUP_COMMANDS: commandList(project.setupCommands),
        VERIFY_COMMANDS: commandList(project.verifyCommands),
      },
    });
    return result.commits;
  } finally {
    await sandbox.close();
  }
}

async function fixGitHubReviewRequest(item: FailedGitHubReviewRequest, workspaces: Map<string, string>) {
  const { project, pr, runs, checks } = item;
  const workspace = workspaces.get(project.repo)!;
  sh(`git fetch origin ${JSON.stringify(`pull/${pr.number}/head:${pr.headRefName}`)}`, { cwd: workspace, allowFailure: true });
  const runLogs = failedGithubRuns(runs)
    .map((run) => `===== ${run.workflowName ?? run.name ?? `run ${run.databaseId}`} (${run.databaseId}) =====\n${githubRunTrace(project, run.databaseId)}`)
    .join("\n\n")
    .slice(-24000);
  const conflicts = prHasConflicts(pr) ? githubConflictSummary(project, pr, workspace).slice(-12000) : "PR is not currently reported as conflicted.";

  const sandbox = await sandcastle.createSandbox({
    cwd: workspace,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    sandbox: sandboxProvider(project),
    hooks: sandboxHooks(project),
  });

  try {
    const result = await sandbox.run({
      name: `${workspaceName(project.repo)}-pr-${pr.number}-ci-fixer`,
      maxIterations: 60,
      idleTimeoutSeconds: 1800,
      agent: AGENT,
      promptFile: join(PROMPT_DIR, "github-ci-fix-prompt.md"),
      promptArgs: {
        REPO: project.repo,
        PR_NUMBER: String(pr.number),
        PR_TITLE: pr.title,
        BRANCH: pr.headRefName,
        MR_TARGET_BRANCH: pr.baseRefName,
        PR_URL: pr.url ?? String(pr.number),
        FAILED_CHECKS: githubFailedCheckSummary(checks) || "No failed checks found from `gh pr checks`.",
        FAILED_RUNS: githubFailedRunSummary(runs) || "No failed GitHub Actions runs found for the PR head commit.",
        JOB_LOGS: runLogs || "No failed GitHub Actions logs found.",
        CONFLICT_SUMMARY: conflicts,
        SETUP_COMMANDS: commandList(project.setupCommands),
        VERIFY_COMMANDS: commandList(project.verifyCommands),
      },
    });
    return result.commits;
  } finally {
    await sandbox.close();
  }
}

async function fixReviewRequest(item: FailedReviewRequest, workspaces: Map<string, string>) {
  return item.forge === "gitlab"
    ? fixGitLabReviewRequest(item, workspaces)
    : fixGitHubReviewRequest(item, workspaces);
}

async function runFailedReviewRequests() {
  const gitlabProjects = projects.filter((project) => projectForge(project) === "gitlab");
  const githubProjects = projects.filter((project) => projectForge(project) === "github");
  const failedReviewRequests = [
    ...listFailedGitLabReviewRequests(gitlabProjects),
    ...listFailedGitHubReviewRequests(githubProjects),
  ].slice(0, MAX_ISSUES_PER_RUN);
  const workspaces = prepareWorkspaces(failedReviewRequests.map((item) => item.project));

  console.log(`\n${heading(`Selected ${failedReviewRequests.length} failed/conflicted review request(s) labelled ${ELIGIBLE_CI_FIX_MR_LABELS.join(" or ")}:`)}`);
  for (const item of failedReviewRequests) {
    console.log(`- ${color.cyan(reviewRequestRef(item))}: ${reviewRequestTitle(item)} ${color.dim(`(${reviewRequestReasons(item)})`)}`);
  }

  const settled = await Promise.allSettled(failedReviewRequests.map((item) => fixReviewRequest(item, workspaces)));

  for (const [i, outcome] of settled.entries()) {
    const item = failedReviewRequests[i]!;
    if (outcome.status === "rejected") console.error(failure(`✗ ${reviewRequestRef(item)} failed:`), outcome.reason);
    else console.log(success(`✓ ${reviewRequestRef(item)}: ${outcome.value.length} commit(s)`));
  }
}

const mode = process.argv[2] ?? "issues";
if (mode === "issues") await runIssues();
else if (mode === "to-issues-prd") await runToIssuesPrd();
else if (mode === "implement-prd") await runImplementPrd();
else if (mode === "fix-failed-review-requests") await runFailedReviewRequests();
else throw new Error(`Unknown mode: ${mode}`);

console.log(`\n${success("All done.")}`);
