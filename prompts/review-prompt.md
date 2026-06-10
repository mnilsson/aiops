# TASK

Review branch `{{BRANCH}}` against `{{MR_TARGET_BRANCH}}` in `{{REPO}}` for {{ISSUE_TRACKER}} issue `{{ISSUE_ID}}`.

# REVIEW CHECKLIST

- Does the change solve only the target issue?
- Are tests/verification appropriate?
- Are there new failures compared with baseline? If yes, fix them or stop.
- Is the code simpler, clearer, and consistent with local style?
- Are secrets, deployment config, or high-risk files touched unnecessarily?

If safe improvements are obvious, make them and commit with `AGENT: review refinements`.
If no changes are needed, do nothing.

Baseline verification from `{{MR_TARGET_BRANCH}}`:

```text
baseline ok: {{BASELINE_OK}}
{{BASELINE_OUTPUT}}
```

Run verification again after changes:

{{VERIFY_COMMANDS}}

When complete, output `<promise>COMPLETE</promise>`.
