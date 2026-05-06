import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readPlanningSnapshot } from "./read.js";
import { resolvePlanningDir } from "../shared.js";

export type MilestoneIdentity = {
  version: string;
  name: string;
};

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export function resolveCurrentMilestone(cwd: string): MilestoneIdentity | undefined {
  const snapshot = readPlanningSnapshot(cwd);
  const version = normalizeWhitespace(snapshot.state?.milestone ?? "");
  const name = normalizeWhitespace(snapshot.state?.milestone_name ?? "");
  if (version.length === 0) {
    return undefined;
  }
  return { version, name: name.length > 0 ? name : version };
}

export function listArchivedMilestones(cwd: string): MilestoneIdentity[] {
  const milestonesDir = join(resolvePlanningDir(cwd), "milestones");
  if (!existsSync(milestonesDir)) {
    return [];
  }
  return readdirSync(milestonesDir)
    .map((entry) => entry.match(/^(v\d+(?:\.\d+){0,2})-(.+)\.(?:md)$/u))
    .filter((entry): entry is RegExpMatchArray => entry !== null)
    .map((entry) => ({ version: entry[1] ?? "", name: entry[1] ?? "" }))
    .filter(
      (entry, index, list) =>
        entry.version.length > 0 &&
        list.findIndex((item) => item.version === entry.version) === index,
    )
    .toSorted((left, right) =>
      left.version.localeCompare(right.version, undefined, { numeric: true }),
    );
}
