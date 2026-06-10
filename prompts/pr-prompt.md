# TASK

Open a GitHub pull request for branch `{{BRANCH}}` in `{{REPO}}`.

Target branch: `{{MR_TARGET_BRANCH}}`
Issue: `#{{ISSUE_ID}}` — {{ISSUE_TITLE}}

# RULES

- Do not merge the PR.
- Do not close the issue directly.
- PR body must include `Closes #{{ISSUE_ID}}`.
- Remove issue label `ready-for-agent` after PR creation.
- Add issue label `agent-mr-opened` after PR creation.
- Add PR label `agent-created` after PR creation.
- If a PR already exists, do not create a duplicate; normalize labels instead.
- Never force-push over unknown work.

# BASELINE VERIFICATION

```text
baseline ok: {{BASELINE_OK}}
{{BASELINE_OUTPUT}}
```

# PR DESCRIPTION MUST INCLUDE

- Linked issue
- Summary of changes
- Baseline verification result
- Branch verification result
- Any remaining pre-existing failures
- Reviewer notes, especially for high-risk repos

When complete, output `<promise>COMPLETE</promise>`.
