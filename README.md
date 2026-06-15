# aiops

Local Sandcastle orchestration for allowlisted GitLab and GitHub repositories.

This repo is safe to publish publicly: organization-specific project allowlists live in the gitignored `projects.local.ts`. The tracked `projects.example.ts` is only a template.

## Current policy

- Runs locally/manual only.
- Uses GitLab and GitHub issues.
- Processes max 4 issues / Parent PRDs per run.
- By default, only processes workflow items authored by the authenticated CLI user running aiops.
- Prioritizes issues labelled `critical`, then oldest eligible issue.
- Normal standalone issues require `ready-for-agent`.
- High-risk standalone issues should require `ready-for-agent` and `agent-approved`.
- PRD workflow uses ordinary Parent PRD issues and ordinary Slice Issues linked by aiops markers.
- High-risk Parent PRDs require `agent-approved` in addition to `agent-to-issues` or `agent-implement-prd`.
- Opens GitLab MRs or GitHub PRs for human review; never auto-merges.
- On MR/PR creation, removes `ready-for-agent` and adds `agent-mr-opened`.
- Labels created MRs/PRs with `agent-created`.
- No new verification failures are allowed.

## Configure projects

Create a private local config from the public template:

```bash
cp projects.example.ts projects.local.ts
```

Then edit `projects.local.ts` with your project allowlist, forge (`gitlab` or `github`), setup commands, verification commands, and risk level. Existing configs default to `gitlab`. Workflow item selection defaults to `authorScope: "self"`, meaning aiops only handles issues, Parent PRDs, Slice Issues, and Review Requests authored by the authenticated `glab`/`gh` user running it; set `authorScope: "any"` only for projects where this runner may handle workflow items from any author. PRD workflow is enabled by default; set `prdWorkflow: false` for repos that should only use standalone issue mode. This file is ignored by git and should not be committed.

If a repo needs its own dependency base, configure `sandboxBaseImageFromRepo`. aiops will build the named Dockerfile stage from the repo's trusted `defaultBranch`, tag it as an intermediate base, then build a sandbox image with the aiops tooling layer on top:

```ts
sandboxBaseImageFromRepo: {
  dockerfile: "Dockerfile",
  stage: "base", // or "dev"; omit to use the Dockerfile's final image
  context: ".",
  ref: "defaultBranch",
}
```

Use `sandboxImage` instead when you already have a reviewed prebuilt sandbox image.

## Runtime state

Ignored runtime state lives under:

- `projects.local.ts`
- `.aiops/workspaces/`
- `.aiops/sandbox-images/`

## Run

```bash
npm install
npm run check
npm run sandcastle:build-image
# Optional: prebuild project-specific sandbox images configured with sandboxBaseImageFromRepo.
npm run sandcastle:build-project-images
npm run sandcastle
```

To decompose a Parent PRD into ordered Slice Issues, label the Parent PRD `agent-to-issues`, then run:

```bash
npm run sandcastle:to-issues-prd
```

To implement Slice Issues for each eligible Parent PRD, label the Parent PRD `agent-implement-prd`, then run:

```bash
npm run sandcastle:implement-prd
```

The PRD implementation run keeps taking the next valid Slice Issue for each selected Parent PRD until the PRD is complete, a slice is blocked, verification fails, or the safety iteration cap is reached. The PRD workflow opens one draft MR/PR after the first implemented slice, keeps updating that same Review Request, and marks it `agent-ready-for-review` when all slices are implemented.

To ask Sandcastle to inspect failed GitLab CI pipelines / GitHub checks or resolve MR/PR merge conflicts and push focused fixes, use a non-draft MR/PR labelled `agent-created` and/or `agent-fix-ci`, then run:

```bash
npm run sandcastle:fix-failed-review-requests
```

GitHub fork PRs are skipped because the fixer pushes back to the existing PR branch.

## PRD workflow labels

Create these labels in managed repositories before using PRD workflow:

- `agent-to-issues` — decompose a Parent PRD into Slice Issues.
- `agent-implement-prd` — implement the next Slice Issue for a Parent PRD.
- `agent-prd-in-progress` — a shared PRD Review Request exists or is being worked.
- `agent-ready-for-review` — all slices are implemented and the shared Review Request is ready.
- `agent-blocked` — aiops cannot safely continue without human intervention.
- `agent-slice` — marks ordinary issues created as Slice Issues.
- `agent-slice-implemented` — marks a Slice Issue implemented on the shared branch.
- `agent-created` — marks aiops-created Slice Issues and Review Requests.

The default Docker image is shared across all managed project workspaces as `sandcastle:aiops`. Project configs can override it with `sandboxImage` or build a derived image with `sandboxBaseImageFromRepo`. Derived images currently support Debian/Ubuntu-style `apt-get` bases and Alpine `apk` bases; distroless/minimal bases should use a dedicated prebuilt `sandboxImage`. The image includes both `glab` and `gh`; authenticate both CLIs on the host before managing private projects. GitHub sandbox auth is mounted from `GH_CONFIG_DIR` or common `gh` config directories when present.
