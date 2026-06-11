# TASK

Break Parent PRD `{{PARENT_PRD_ID}}` in `{{REPO}}` into ordered Slice Issues.

Parent PRD: {{PARENT_PRD_TITLE}}
Tracker: {{ISSUE_TRACKER}}

# CONTEXT

Pull full PRD context, including comments, with:

```bash
{{PARENT_PRD_VIEW_COMMAND}}
```

# RULES

- Create at most {{MAX_SLICES}} slices.
- Each slice must be independently implementable and reviewable.
- Preserve implementation order: foundational changes first, follow-up behavior/tests later.
- Do not create a slice that means "do the whole PRD".
- Do not create issues yourself. Only return JSON.
- Do not include numeric prefixes in titles; the orchestrator adds them.

# OUTPUT

Return JSON in `<slices>` tags exactly like this:

<slices>
{"slices":[{"title":"Add schema support","body":"Implement the smallest storage/model change needed for...\n\n## Acceptance criteria\n- ..."}]}
</slices>
