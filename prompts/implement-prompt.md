# TASK

Fix {{ISSUE_TRACKER}} issue `{{ISSUE_ID}}` in `{{REPO}}`: {{ISSUE_TITLE}}

Work on branch `{{BRANCH}}` targeting `{{MR_TARGET_BRANCH}}`.

# RULES

- Only work on this issue.
- Pull full issue context with `{{ISSUE_VIEW_COMMAND}}`.
- If related issues/PRDs are referenced, read them too.
- If the issue has a `Blocked by` section, check each blocker state with {{ISSUE_TRACKER}}. Closed blockers are not blockers; continue work when all blockers are closed.
- Do not touch production secrets or deployment state.
- No new verification failures are allowed.
- If baseline verification failed before your work, your branch must improve it or preserve exactly the same unrelated failures.

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

If blocked, leave a {{ISSUE_TRACKER}} issue comment explaining the blocker and do not make speculative changes.

When complete, output `<promise>COMPLETE</promise>`.
