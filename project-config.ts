import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Forge = "gitlab" | "github";
export type ProjectRisk = "normal" | "high";
export type BaselineMode = "local" | "gitlab-quality";

export type SandcastleProject = {
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
  risk: ProjectRisk;
  requiredLabels: string[];
  setupCommands: string[];
  verifyCommands: string[];
  /** Defaults to "gitlab" for existing configs. */
  forge?: Forge;
  /** "gitlab-quality" is only supported for GitLab projects. */
  baselineMode?: BaselineMode;
  sandboxImage?: string;
};

export const NORMAL_LABELS = ["ready-for-agent"];
export const HIGH_RISK_LABELS = ["ready-for-agent", "agent-approved"];

export const MAX_ISSUES_PER_RUN = 4;
export const PRIORITY_LABEL = "critical";
export const BASELINE_FIX_LABEL = "fix-baseline";
export const IN_PROGRESS_LABEL = "agent-mr-opened";
export const BLOCKED_LABELS = [
  "blocked",
  "on-hold",
  "wontfix",
  "icebox",
  "needs-design",
  "human-only",
];

type ProjectConfigModule = {
  projects?: SandcastleProject[];
};

const CONFIG_FILE = "projects.local.ts";

export async function loadProjects(): Promise<SandcastleProject[]> {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), CONFIG_FILE);

  if (!existsSync(configPath)) {
    console.warn(`No ${CONFIG_FILE} found. Copy projects.example.ts to configure local projects.`);
    return [];
  }

  const config = await import(pathToFileURL(configPath).href) as ProjectConfigModule;
  if (!Array.isArray(config.projects)) {
    throw new Error(`${CONFIG_FILE} must export a SandcastleProject[] named "projects".`);
  }

  return config.projects;
}
