# TASK

Fix the failing GitHub checks and/or merge conflicts for pull request `#{{PR_NUMBER}}` in `{{REPO}}`.

This PR was selected because it has `agent-created` and/or `agent-fix-ci` labels.

PR title: {{PR_TITLE}}
Source branch: `{{BRANCH}}`
Target branch: `{{MR_TARGET_BRANCH}}`
PR: {{PR_URL}}

# RULES

- Work only on the existing PR branch.
- Fix only the CI failure(s) and/or merge conflicts shown below; do not broaden the PR scope.
- Prefer the smallest safe change.
- Do not merge the PR.
- Do not close linked issues directly.
- Never force-push over unknown work.
- If the failure is external/flaky/infrastructure-only, leave a PR comment explaining that and do not make speculative changes.
- No new verification failures are allowed.

# FAILED CHECKS

```text
{{FAILED_CHECKS}}
```

# FAILED GITHUB ACTIONS RUNS

```text
{{FAILED_RUNS}}
```

# FAILED JOB LOG EXCERPTS

```text
{{JOB_LOGS}}
```

# MERGE CONFLICTS

If conflicts are shown, merge `origin/{{MR_TARGET_BRANCH}}` into `{{BRANCH}}`, resolve conflicts with the smallest safe changes that preserve the PR intent, then continue verification.

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
