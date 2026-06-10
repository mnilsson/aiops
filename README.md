# aiops

Local Sandcastle orchestration for allowlisted GitLab and GitHub repositories.

This repo is safe to publish publicly: organization-specific project allowlists live in the gitignored `projects.local.ts`. The tracked `projects.example.ts` is only a template.

## Current policy

- Runs locally/manual only.
- Uses GitLab and GitHub issues.
- Processes max 4 issues per run.
- Prioritizes issues labelled `critical`, then oldest eligible issue.
- Normal repos require `ready-for-agent`.
- High-risk repos should require `ready-for-agent` and `agent-approved`.
- Opens GitLab MRs or GitHub PRs for human review; never auto-merges.
- On MR/PR creation, removes `ready-for-agent` and adds `agent-mr-opened`.
- Labels created MRs/PRs with `agent-created`.
- No new verification failures are allowed.

## Configure projects

Create a private local config from the public template:

```bash
cp projects.example.ts projects.local.ts
```

Then edit `projects.local.ts` with your project allowlist, forge (`gitlab` or `github`), setup commands, verification commands, and risk level. Existing configs default to `gitlab`. This file is ignored by git and should not be committed.

## Runtime state

Ignored runtime state lives under:

- `projects.local.ts`
- `.aiops/workspaces/`

## Run

```bash
npm install
npm run check
npm run sandcastle:build-image
npm run sandcastle
```

To ask Sandcastle to inspect failed GitLab CI pipelines / GitHub checks or resolve MR/PR merge conflicts and push focused fixes, use an MR/PR labelled `agent-created` and/or `agent-fix-ci`, then run:

```bash
npm run sandcastle:fix-failed-review-requests
```

GitHub fork PRs are skipped because the fixer pushes back to the existing PR branch.

The default Docker image is shared across all managed project workspaces as `sandcastle:aiops`. The image includes both `glab` and `gh`; authenticate both CLIs on the host before managing private projects. GitHub sandbox auth is mounted from `GH_CONFIG_DIR` or common `gh` config directories when present.
