import type { PluginServerContext } from "@getpaseo/plugin/server";

import { branchesRpc, diffRpc, fileBytesRpc, fileRpc, filesRpc, writeFileRpc, statusRpc, syntaxThemeRpc, syntaxThemesRpc, webBundleRpc } from "./shared/contracts.js";
import { reviewRpc, viewerRpc } from "./shared/review.js";
import { prismSettings } from "./shared/settings.js";
import { coalesce } from "./server/coalesce.js";
import { WEB_BUNDLE } from "./server/web-bundle.generated.js";
import { listSyntaxThemes, resolveSyntaxTheme } from "./server/syntax-themes.js";
import { readWorkspaceFile, readWorkspaceFileChunk, writeWorkspaceFile } from "./server/files.js";
import { readViewer } from "./server/github.js";
import { applyReviewAction } from "./server/reviews.js";
import { listBranches, listFiles, readFileDiff, readStatus } from "./server/git.js";

const COALESCE_MS = 800;

export default function contribute(server: PluginServerContext) {
  server.registerSettings(prismSettings);
  const status = coalesce(
    ({ cwd, compare }: { cwd: string; compare: Parameters<typeof readStatus>[1] }) => readStatus(cwd, compare),
    ({ cwd, compare }) => `${cwd}\0${compare.mode}\0${compare.baseRef}`,
    COALESCE_MS,
  );
  server.handle(statusRpc, (input) => status(input));
  server.handle(branchesRpc, ({ cwd }) => listBranches(cwd));
  server.handle(diffRpc, (input) => readFileDiff(input));
  server.handle(filesRpc, ({ cwd, includeIgnored }) => listFiles(cwd, includeIgnored));
  server.handle(fileRpc, (input) => readWorkspaceFile(input));
  server.handle(fileBytesRpc, (input) => readWorkspaceFileChunk(input));
  server.handle(writeFileRpc, (input) => writeWorkspaceFile(input));
  server.handle(reviewRpc, ({ workspaceId, action }) => applyReviewAction(workspaceId, action));
  server.handle(viewerRpc, async () => ({ viewer: await readViewer() }));
  server.handle(syntaxThemeRpc, (input) => resolveSyntaxTheme(input));
  server.handle(syntaxThemesRpc, async () => ({ themes: await listSyntaxThemes() }));
  server.handle(webBundleRpc, ({ offset, length }) => ({
    total: WEB_BUNDLE.length,
    chunk: WEB_BUNDLE.slice(offset, offset + length),
  }));
  return () => {};
}
