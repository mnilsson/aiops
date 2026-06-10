# TASK

Plan work for the configured allowlisted GitLab projects.

Eligible issues are supplied by the orchestrator. Select at most `{{MAX_ISSUES}}` issues.

Rules:
- Prioritize issues labelled `critical`.
- Then pick oldest eligible issues first.
- Same-repo issues may run together only if they are unlikely to conflict.
- If a repo baseline is failing, select only issues labelled `fix-baseline` or issues clearly about CI/test/build failures.
- Use branch format `agent/<issue-iid>-<slug>`.

# OUTPUT

Return JSON in `<plan>` tags:

<plan>
{"issues":[{"repo":"group/example-app","id":"42","title":"Fix auth bug","branch":"agent/42-fix-auth-bug"}]}
</plan>
