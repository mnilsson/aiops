# Use ordinary issues for PRD slices

aiops will model a PRD Workflow with ordinary Parent PRD and Slice Issues on both GitLab and GitHub, linked by explicit machine-readable markers in issue bodies, rather than GitLab child work items or GitHub native sub-issues. This keeps the first cross-forge implementation simple and avoids depending on forge-specific hierarchy features whose availability and APIs differ.
