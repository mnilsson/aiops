# TASK

Address unresolved Review Comments on the PRD Workflow Review Request `{{REVIEW_REQUEST_REF}}` in `{{REPO}}`.

Review Request title: {{REVIEW_REQUEST_TITLE}}
Review Request: {{REVIEW_REQUEST_URL}}
Parent PRD: {{PARENT_PRD_REF}}
Source branch: `{{BRANCH}}`
Target branch: `{{MR_TARGET_BRANCH}}`

# RULES

- Work only on the existing Review Request branch.
- Address only the Review Comments listed below and any directly necessary follow-up changes.
- Stay within the existing Review Request intent; do not implement new PRD slices or unrelated improvements.
- Human-authored Review Comments should be fixed unless they are unsafe, incorrect, or outside this Review Request's scope.
- Automated Review Service comments should be fixed only when they are reasonable and important enough to justify a code change. Low-value, subjective, incorrect, or out-of-scope automated comments may be skipped with a reason.
- Do not resolve review threads.
- Do not reply to review threads; the orchestrator will post replies after verification and push.
- Do not merge the Review Request.
- Do not close linked issues directly.
- Never force-push over unknown work.
- Do not push. The orchestrator will verify and push only if safe.
- No new verification failures are allowed.

# MERGE CONFLICTS

If conflicts are shown, merge `origin/{{MR_TARGET_BRANCH}}` into `{{BRANCH}}`, resolve conflicts with the smallest safe changes that preserve the Review Request intent, then continue.

```text
{{CONFLICT_SUMMARY}}
```

# REVIEW COMMENTS

For each thread below, decide and report one status:

- `fixed`: you made a code change that addresses the thread.
- `skipped`: automated-review thread only; you intentionally made no change because the suggestion is low-value, incorrect, subjective, duplicate, or out of scope.
- `unfixed`: you could not safely address the thread.

{{REVIEW_COMMENTS}}

# REVIEW REQUEST BODY

```md
{{REVIEW_REQUEST_BODY}}
```

# SETUP

Run setup commands if needed:

{{SETUP_COMMANDS}}

# VERIFY

The orchestrator will run the configured verification before pushing. You may run focused checks locally while working, starting with:

{{VERIFY_COMMANDS}}

# REPORT

Before finishing, write this JSON file exactly:

`{{REPORT_PATH}}`

Schema:

```json
{
  "summary": "short summary of what you changed or why no change was made",
  "threads": [
    {
      "id": "THREAD_ID from the prompt",
      "status": "fixed | skipped | unfixed",
      "reason": "short human-readable reason; required for skipped or unfixed"
    }
  ]
}
```

Requirements:

- Include exactly one `threads` entry for every listed `THREAD_ID`.
- Do not include thread IDs that were not listed.
- Use `skipped` only for Automated Review Service threads.
- Do not commit the report file.
- If you changed code, commit your code changes with a concise commit message starting with `AGENT:`.
- Do not push.

Output `<promise>COMPLETE</promise>` when done.
