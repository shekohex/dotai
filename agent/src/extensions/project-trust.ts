import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";
import { resolve, sep } from "node:path";

const trustedProjectRoots = ["/home/coder/project", "/home/coder/dotai"] as const;

function isPathInsideOrEqual(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

export function isDefaultTrustedProjectPath(path: string): boolean {
  return trustedProjectRoots.some((root) => isPathInsideOrEqual(path, root));
}

export default function projectTrustExtension(pi: ExtensionAPI) {
  pi.on("project_trust", (event): ProjectTrustEventResult => {
    if (isDefaultTrustedProjectPath(event.cwd)) {
      return { trusted: "yes", remember: true };
    }

    return { trusted: "undecided" };
  });
}
