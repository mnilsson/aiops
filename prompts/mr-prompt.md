# TASK

Open a GitLab merge request for branch `{{BRANCH}}` in `{{REPO}}`.

Target branch: `{{MR_TARGET_BRANCH}}`
Issue: `#{{ISSUE_ID}}` — {{ISSUE_TITLE}}

# RULES

- Do not merge the MR.
- Do not close the issue directly.
- MR description must include `Closes #{{ISSUE_ID}}`.
- Remove issue label `ready-for-agent` after MR creation.
- Add issue label `agent-mr-opened` after MR creation.
- Add MR label `agent-created` after MR creation.
- If an MR already exists, do not create a duplicate; normalize labels instead.
- Never force-push over unknown work.

# BASELINE VERIFICATION

```text
baseline ok: {{BASELINE_OK}}
{{BASELINE_OUTPUT}}
```

# MR DESCRIPTION MUST INCLUDE

- Linked issue
- Summary of changes
- Baseline verification result
- Branch verification result
- Any remaining pre-existing failures
- Reviewer notes, especially for high-risk repos

When complete, output `<promise>COMPLETE</promise>`.
