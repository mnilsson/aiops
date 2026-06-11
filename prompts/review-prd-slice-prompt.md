# TASK

Review branch `{{BRANCH}}` against `{{MR_TARGET_BRANCH}}` in `{{REPO}}` for Slice Issue `{{SLICE_ISSUE_ID}}` of Parent PRD `{{PARENT_PRD_ID}}`.

# REVIEW CHECKLIST

- Does the change solve only the current Slice Issue?
- Does it avoid implementing later slices from the Parent PRD?
- Are tests/verification appropriate?
- Are there new failures compared with baseline? If yes, fix them or stop.
- Is the code simpler, clearer, and consistent with local style?
- Are secrets, deployment config, or high-risk files touched unnecessarily?

Current Slice Issue: {{SLICE_ISSUE_TITLE}}

All slices:

```text
{{SLICE_LIST}}
```

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
