import { readPlanningSnapshot } from "./read.js";

export type RoadmapPhase = {
  number: string;
  name: string;
  goal?: string;
  mode?: string;
  requirements: string[];
  successCriteria: string[];
  dependsOn?: string;
  plans: Array<{ id: string; title: string; completed: boolean }>;
};

const phaseHeaderPattern =
  /^#{3,4}\s+Phase\s+([0-9]+(?:\.[0-9]+)?):\s+(.+?)(?:\s+\(INSERTED\))?\s*$/gm;

function readSection(content: string, start: number, end: number): string {
  return content.slice(start, end).trim();
}

function extractList(section: string, label: string): string[] {
  const match = section.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`));
  if (!match || match[1] === undefined) {
    return [];
  }
  return match[1]
    .replaceAll(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function extractSingle(section: string, label: string): string | undefined {
  const match = section.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`));
  return match?.[1]?.trim();
}

function extractSuccessCriteria(section: string): string[] {
  const match = section.match(/\*\*Success Criteria\*\*[\s\S]*?(?=\n\*\*Plans\*\*|\nPlans:|$)/);
  if (!match) {
    return [];
  }
  return match[0]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\./.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, "").trim());
}

function extractPlanList(
  section: string,
): Array<{ id: string; title: string; completed: boolean }> {
  const plansBlock = section.match(/Plans:\s*\n([\s\S]*)$/);
  if (!plansBlock || plansBlock[1] === undefined) {
    return [];
  }
  return plansBlock[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^- \[[ x]\]/.test(line))
    .map((line) => {
      const match = line.match(/^- \[([ x])\]\s+([^:]+):\s+(.+)$/);
      return {
        id: match?.[2]?.trim() ?? line,
        title: match?.[3]?.trim() ?? line,
        completed: match?.[1] === "x",
      };
    });
}

export function parseRoadmap(content: string): RoadmapPhase[] {
  const headers = [...content.matchAll(phaseHeaderPattern)];
  return headers.map((header, index) => {
    const next = headers[index + 1];
    const start = header.index ?? 0;
    const end = next?.index ?? content.length;
    const section = readSection(content, start, end);
    return {
      number: header[1] ?? "",
      name: header[2]?.trim() ?? "",
      goal: extractSingle(section, "Goal"),
      mode: extractSingle(section, "Mode")?.toLowerCase(),
      requirements: extractList(section, "Requirements"),
      successCriteria: extractSuccessCriteria(section),
      dependsOn: extractSingle(section, "Depends on"),
      plans: extractPlanList(section),
    };
  });
}

export function readRoadmapPhases(cwd: string): RoadmapPhase[] {
  const roadmap = readPlanningSnapshot(cwd).roadmap;
  return roadmap !== undefined && roadmap.length > 0 ? parseRoadmap(roadmap) : [];
}
