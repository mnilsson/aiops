# TASK

Implement Slice Issue `{{SLICE_ISSUE_ID}}` for Parent PRD `{{PARENT_PRD_ID}}` in `{{REPO}}`.

Parent PRD: {{PARENT_PRD_TITLE}}
Current Slice Issue: {{SLICE_ISSUE_TITLE}}
Branch: `{{BRANCH}}`
Target branch: `{{MR_TARGET_BRANCH}}`
Shared Review Request: {{REVIEW_REQUEST_URL}}

# RULES

- Only implement the current Slice Issue.
- Start from the latest `origin/{{BRANCH}}` state for `{{BRANCH}}` when it exists; do not build on stale local-only branch state.
- Before editing, confirm `git status --short` is clean; if it is not clean, stop and report the blocker.
- Keep the Parent PRD context in mind, but do not implement later slices.
- Pull full Parent PRD context with `{{PARENT_PRD_VIEW_COMMAND}}`.
- Pull full current Slice Issue context with `{{SLICE_ISSUE_VIEW_COMMAND}}`.
- Do not create, edit, close, or label issues.
- Do not create or update MRs/PRs; the orchestrator handles the shared Review Request.
- Do not force-push.
- Do not touch production secrets or deployment state.
- No new verification failures are allowed.
- If blocked, leave the working tree clean and explain the blocker in your final output; do not make speculative changes.

# ALL SLICES

```text
{{SLICE_LIST}}
```

# SETUP

Run setup commands if needed:

{{SETUP_COMMANDS}}

# VERIFY

Baseline verification from `{{MR_TARGET_BRANCH}}`:

```text
baseline ok: {{BASELINE_OK}}
{{BASELINE_OUTPUT}}
```

Before committing, run:

{{VERIFY_COMMANDS}}

# COMMIT

Commit your changes on `{{BRANCH}}`.
Use a concise commit message starting with `AGENT:`.

When complete, output `<promise>COMPLETE</promise>`.
