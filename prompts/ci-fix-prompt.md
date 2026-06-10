# TASK

Fix the failing GitLab CI pipeline and/or merge conflicts for merge request `!{{MR_IID}}` in `{{GITLAB_REPO}}`.

This MR was selected because it has `agent-created` and/or `agent-fix-ci` labels.

MR title: {{MR_TITLE}}
Source branch: `{{BRANCH}}`
Target branch: `{{MR_TARGET_BRANCH}}`
Pipeline: {{PIPELINE_URL}}

# RULES

- Work only on the existing MR branch.
- Fix only the CI failure(s) and/or merge conflicts shown below; do not broaden the MR scope.
- Prefer the smallest safe change.
- Do not merge the MR.
- Do not close linked issues directly.
- Never force-push over unknown work.
- If the failure is external/flaky/infrastructure-only, leave an MR comment explaining that and do not make speculative changes.
- No new verification failures are allowed.

# FAILED CI JOBS

```text
{{FAILED_JOBS}}
```

# FAILED JOB LOG EXCERPTS

```text
{{JOB_LOGS}}
```

# MERGE CONFLICTS

If conflicts are shown, merge `origin/{{MR_TARGET_BRANCH}}` into `{{BRANCH}}`, resolve conflicts with the smallest safe changes that preserve the MR intent, then continue verification.

```text
{{CONFLICT_SUMMARY}}
```

# SETUP

Run setup commands if needed:

{{SETUP_COMMANDS}}

# VERIFY

Before committing, run relevant checks, starting with:

{{VERIFY_COMMANDS}}

When complete, commit your changes with a concise commit message starting with `AGENT:` and push to `{{BRANCH}}`.

Output `<promise>COMPLETE</promise>` when done.
