# Dispatch requires configurable label and assignee

Pi Conductor will not dispatch every labeled issue on a managed project. A work item is eligible only when its linked issue is open, has no merged pull request for the planned conductor branch, has the `.pi/WORKFLOW.md` dispatch label, defaulting to `ready-for-agent`, and is assigned to the authenticated `gh` account running conductor. Project status is not an eligibility gate; it is used for lifecycle transitions after claim.

If reconciliation sees a closed project item with an existing active run, Conductor marks that stale run blocked and stops its Herdr pane best-effort before normal active-run recovery can relaunch it.
