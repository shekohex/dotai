import type { ConductorStore, LifecycleStatus, WorkItem } from "./store/types.js";

export function isEligibleForAutomatedDispatch(
  workItem: WorkItem,
  dispatchLabel: string,
  authenticatedLogin: string,
): boolean {
  return workItem.labels.includes(dispatchLabel) && workItem.assignees.includes(authenticatedLogin);
}

export async function hasRunStatusForWorkItem(
  store: ConductorStore,
  workItem: WorkItem,
  status: LifecycleStatus,
): Promise<boolean> {
  return (await store.listRuns()).some(
    (run) =>
      run.owner === workItem.owner &&
      run.repo === workItem.repo &&
      run.issueNumber === workItem.issueNumber &&
      run.status === status,
  );
}
