import type {
  SubagentToolProgressDetails,
  SubagentToolRenderDetails,
  SubagentToolResultDetails,
} from "../../subagent-sdk/types.js";

function isProgressDetails(details: unknown): details is SubagentToolProgressDetails {
  return (
    details !== null && typeof details === "object" && "phase" in details && "statusText" in details
  );
}

function isSubagentToolResultDetails(details: unknown): details is SubagentToolResultDetails {
  if (details === null || typeof details !== "object") {
    return false;
  }
  if (!("action" in details) || typeof details.action !== "string") {
    return false;
  }
  if (details.action === "list") {
    return "subagents" in details && Array.isArray(details.subagents);
  }
  if (details.action === "start") {
    return "state" in details && "prompt" in details;
  }
  if (details.action === "cancel") {
    return "state" in details;
  }
  if (details.action === "message") {
    return "state" in details && "message" in details;
  }
  return false;
}

function isSubagentToolRenderDetails(value: unknown): value is SubagentToolRenderDetails {
  return isSubagentToolResultDetails(value) || isProgressDetails(value);
}

export { isProgressDetails, isSubagentToolRenderDetails, isSubagentToolResultDetails };
