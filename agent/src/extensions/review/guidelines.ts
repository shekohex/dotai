import { promises as fs } from "node:fs";
import path from "node:path";

async function findGitRoot(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const gitPath = path.join(currentDir, ".git");
    const gitStats = await fs.stat(gitPath).catch(() => null);
    if (gitStats?.isDirectory() === true || gitStats?.isFile() === true) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
  let currentDir = path.resolve(cwd);
  const gitRoot = await findGitRoot(currentDir);

  while (true) {
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
    const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
    if (guidelineStats?.isFile() === true) {
      try {
        const content = await fs.readFile(guidelinesPath, "utf8");
        const trimmed = content.trim();
        return trimmed || null;
      } catch {
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || currentDir === gitRoot) {
      return null;
    }
    currentDir = parentDir;
  }
}
