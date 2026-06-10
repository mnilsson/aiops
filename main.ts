import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
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
  references?: { full: string };
};

type GitHubIssue = {
  number: number;
  title: string;
  body?: string;
  labels?: Array<string | { name?: string }>;
  createdAt?: string;
  url?: string;
};

type TrackedIssue = {
  iid: number;
  title: string;
  description?: string;
  labels?: string[];
  created_at?: string;
  web_url?: string;
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

const SANDBOX_IMAGE = "sandcastle:aiops";
const AGENT_MR_LABEL = "agent-created";
const CI_FIX_LABEL = "agent-fix-ci";
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
    "--json number,title,body,labels,createdAt,url",
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
      references: { full: `${project.repo}#${issue.number}` },
    }))
    .filter((issue) => !issue.labels.includes(IN_PROGRESS_LABEL))
    .map((issue) => toCandidateIssue(project, issue));
}

function listIssues(project: SandcastleProject): CandidateIssue[] {
  return projectForge(project) === "github" ? listGitHubIssues(project) : listGitLabIssues(project);
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

function sandboxBaselineCommand(project: SandcastleProject): string {
  const setupLines = project.setupCommands.map((command) => `run_step "setup" ${shellQuote(command)}`);
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
    "echo __SANDCASTLE_BASELINE_STATUS__=$ok",
  ].join("\n");
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

const issueStateCache = new Map<string, string>();

function splitIssueRef(ref: string): { repo: string; iid: string } | undefined {
  const index = ref.lastIndexOf("#");
  if (index < 1 || index === ref.length - 1) return undefined;
  return { repo: ref.slice(0, index), iid: ref.slice(index + 1) };
}

function issueRefIsClosed(ref: string, forge: Forge): boolean {
  const cacheKey = `${forge}:${ref}`;
  if (issueStateCache.has(cacheKey)) return issueStateCache.get(cacheKey) === "closed";

  const parsed = splitIssueRef(ref);
  if (!parsed) return false;

  const command = forge === "github"
    ? `gh issue view ${shellQuote(parsed.iid)} -R ${shellQuote(parsed.repo)} --json state`
    : `glab issue view ${shellQuote(parsed.iid)} -R ${shellQuote(parsed.repo)} --output json`;
  const raw = sh(command, { allowFailure: true });
  try {
    const state = ((JSON.parse(raw) as { state?: string }).state ?? "unknown").toLowerCase();
    issueStateCache.set(cacheKey, state);
    return state === "closed";
  } catch {
    issueStateCache.set(cacheKey, "unknown");
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
  const openBlockers = blockers.filter((ref) => !issueRefIsClosed(ref, issue.forge));
  if (openBlockers.length > 0) {
    console.log(color.yellow(`- ${issue.repo}#${issue.iid}: blocked by ${openBlockers.join(", ")}`));
    return true;
  }
  return false;
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
    `gh pr list -R ${shellQuote(project.repo)} --state open --limit 100 --json number,title,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,labels,url,mergeStateStatus,mergeable`,
  );
  return JSON.parse(raw) as GitHubPullRequest[];
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

function listFailedGitLabReviewRequests(selectedProjects: SandcastleProject[]): FailedGitLabReviewRequest[] {
  return selectedProjects.flatMap((project) =>
    listOpenMergeRequests(project)
      .filter((mr) => !mr.draft)
      .filter((mr) => ELIGIBLE_CI_FIX_MR_LABELS.some((label) => mr.labels?.includes(label)))
      .map((mr) => {
        const detailedMr = getMergeRequest(project, mr.iid) ?? mr;
        return { forge: "gitlab" as const, project, mr: detailedMr, pipeline: latestMrPipeline(detailedMr) };
      })
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
else if (mode === "fix-failed-review-requests") await runFailedReviewRequests();
else throw new Error(`Unknown mode: ${mode}`);

console.log(`\n${success("All done.")}`);
