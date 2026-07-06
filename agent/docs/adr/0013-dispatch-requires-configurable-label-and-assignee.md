# Dispatch requires configurable label and assignee

Pi Conductor will not dispatch every labeled issue on a managed project. A work item is eligible only when its linked issue has the `.pi/WORKFLOW.md` dispatch label, defaulting to `ready-for-agent`, and is assigned to the authenticated `gh` account running conductor. Project status is not an eligibility gate; it is used for lifecycle transitions after claim.
