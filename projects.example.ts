import { HIGH_RISK_LABELS, NORMAL_LABELS, type SandcastleProject } from "./project-config.js";

export const projects: SandcastleProject[] = [
  {
    forge: "gitlab",
    repo: "group/example-app",
    remoteUrl: "git@gitlab.com:group/example-app.git",
    defaultBranch: "main",
    risk: "normal",
    requiredLabels: NORMAL_LABELS,
    // Defaults to "self". Set to "any" only if aiops may handle workflow items from other authors.
    // authorScope: "any",
    setupCommands: ["npm ci"],
    verifyCommands: ["npm test"],
  },
  {
    forge: "github",
    repo: "org/example-infra",
    remoteUrl: "git@github.com:org/example-infra.git",
    defaultBranch: "main",
    risk: "high",
    requiredLabels: HIGH_RISK_LABELS,
    setupCommands: [],
    verifyCommands: ["terraform fmt -check -recursive"],
  },
];
