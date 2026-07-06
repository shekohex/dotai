import type { GlobalConductorConfig } from "./config.js";
import { validateGlobalConfig } from "./config.js";
import type { ConductorStore, LifecycleStatus, WorkItem } from "./store/types.js";

export function assertGlobalConfigReady(config: GlobalConductorConfig): void {
  const errors = validateGlobalConfig(config);
  if (errors.length > 0) throw new Error(`Invalid conductor config:\n${errors.join("\n")}`);
}

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
