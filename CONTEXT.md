# aiops

aiops orchestrates agent work across allowlisted source-control projects while keeping humans responsible for review and merge decisions.

## Language

**Forge**:
An external source-control and issue-tracking platform managed by aiops. Current forges are GitLab and GitHub.

**Review Request**:
A human-reviewed code change proposal opened by the agent. Use this as the forge-neutral term for GitLab merge requests and GitHub pull requests.

**PRD Workflow**:
A workflow where a Parent PRD is decomposed into ordered Slice Issues and delivered through a single Review Request.
_Avoid_: Batch mode

**Parent PRD**:
An ordinary issue that describes a larger desired outcome and coordinates the Slice Issues needed to deliver it.
_Avoid_: Epic, parent task

**Slice Issue**:
An ordinary issue representing one ordered, independently implementable slice of a Parent PRD.
_Avoid_: Child work item, sub-issue, task

**Blocked PRD Workflow**:
A PRD Workflow state where aiops cannot safely continue without human intervention.
