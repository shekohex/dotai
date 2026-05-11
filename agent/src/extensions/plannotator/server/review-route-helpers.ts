import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { PRMetadata, PRReviewFileComment } from "../generated/pr-provider.js";
import { prRefFromMetadata } from "../generated/pr-provider.js";
import type { DiffType } from "../generated/review-core.js";
import type { PRDiffScope } from "../generated/pr-stack.js";
import { saveConfig } from "../generated/config.js";
import { errorMessage } from "../../../utils/error-message.js";
import { json, parseBody, toWebRequest } from "./helpers.js";
import { markPRFilesViewed, submitPRReview } from "./pr.js";
import { canStageFiles, stageFile, unstageFile } from "./vcs.js";

const PrActionSchema = Type.Object({
  action: Type.Union([Type.Literal("approve"), Type.Literal("comment")]),
  body: Type.String(),
  fileComments: Type.Optional(Type.Array(Type.Unknown())),
  targetPrUrl: Type.Optional(Type.String()),
});

const PrViewedSchema = Type.Object({
  filePaths: Type.Array(Type.String()),
  viewed: Type.Boolean(),
});

const ConfigSchema = Type.Object({
  displayName: Type.Optional(Type.String()),
  diffOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  conventionalComments: Type.Optional(Type.Boolean()),
});

const GitAddSchema = Type.Object({
  filePath: Type.String(),
  undo: Type.Optional(Type.Boolean()),
});

const FeedbackSchema = Type.Object({
  approved: Type.Optional(Type.Boolean()),
  feedback: Type.Optional(Type.String()),
  annotations: Type.Optional(Type.Array(Type.Unknown())),
  agentSwitch: Type.Optional(Type.String()),
});

type PrActionBody = Static<typeof PrActionSchema>;
type PrViewedBody = Static<typeof PrViewedSchema>;
type ConfigBody = Static<typeof ConfigSchema>;
type GitAddBody = Static<typeof GitAddSchema>;
type FeedbackBody = Static<typeof FeedbackSchema>;

function parsePrReviewFileComments(input: readonly unknown[] | undefined): PRReviewFileComment[] {
  if (input === undefined) {
    return [];
  }
  return input.filter(
    (comment): comment is PRReviewFileComment => typeof comment === "object" && comment !== null,
  );
}

export async function handleReviewPrAction(args: {
  req: IncomingMessage;
  res: ServerResponse;
  prMeta: PRMetadata;
  prRef: ReturnType<typeof prRefFromMetadata>;
  prSwitchCache: Map<string, { metadata: PRMetadata; rawPatch: string }>;
  currentPRDiffScope: PRDiffScope;
}): Promise<void> {
  try {
    const body = await parseBody(args.req);
    if (!Value.Check(PrActionSchema, body)) {
      json(args.res, { error: "Invalid request" }, 400);
      return;
    }
    const payload: PrActionBody = body;
    const fileComments = parsePrReviewFileComments(payload.fileComments);
    let targetRef = args.prRef;
    let targetHeadSha = args.prMeta.headSha;
    let targetUrl = args.prMeta.url;

    if (payload.targetPrUrl !== undefined && payload.targetPrUrl.length > 0) {
      const cached = args.prSwitchCache.get(payload.targetPrUrl);
      if (cached === undefined) {
        json(args.res, { error: "Target PR not found in session" }, 400);
        return;
      }
      targetRef = prRefFromMetadata(cached.metadata);
      targetHeadSha = cached.metadata.headSha;
      targetUrl = cached.metadata.url;
    } else if (args.currentPRDiffScope !== "layer") {
      json(args.res, { error: "Switch to Layer diff before posting a platform review" }, 400);
      return;
    }

    console.error(
      `[pr-action] ${payload.action} with ${fileComments.length} file comment(s), target=${targetUrl}, headSha=${targetHeadSha}`,
    );
    await submitPRReview(targetRef, targetHeadSha, payload.action, payload.body, fileComments);
    console.error("[pr-action] Success");
    json(args.res, { ok: true, prUrl: targetUrl });
  } catch (err) {
    const message = errorMessage(err) || "Failed to submit PR review";
    console.error(`[pr-action] Failed: ${message}`);
    json(args.res, { error: message }, 500);
  }
}

export async function handleReviewPrViewed(args: {
  req: IncomingMessage;
  res: ServerResponse;
  prMeta: PRMetadata;
  prRef: ReturnType<typeof prRefFromMetadata>;
}): Promise<void> {
  if (args.prMeta.platform !== "github") {
    json(args.res, { error: "Viewed sync only supported for GitHub" }, 400);
    return;
  }
  if (args.prMeta.prNodeId === undefined || args.prMeta.prNodeId.length === 0) {
    json(args.res, { error: "PR node ID not available" }, 400);
    return;
  }
  try {
    const body = await parseBody(args.req);
    if (!Value.Check(PrViewedSchema, body)) {
      json(args.res, { error: "Invalid request" }, 400);
      return;
    }
    const payload: PrViewedBody = body;
    await markPRFilesViewed(args.prRef, args.prMeta.prNodeId, payload.filePaths, payload.viewed);
    json(args.res, { ok: true });
  } catch (err) {
    const message = errorMessage(err) || "Failed to update viewed state";
    console.error("[plannotator] /api/pr-viewed error:", message);
    json(args.res, { error: message }, 500);
  }
}

export async function handleReviewConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await parseBody(req);
    if (!Value.Check(ConfigSchema, body)) {
      json(res, { error: "Invalid request" }, 400);
      return;
    }
    const payload: ConfigBody = body;
    const toSave: Record<string, unknown> = {};
    if (payload.displayName !== undefined) toSave.displayName = payload.displayName;
    if (payload.diffOptions !== undefined) toSave.diffOptions = payload.diffOptions;
    if (payload.conventionalComments !== undefined)
      toSave.conventionalComments = payload.conventionalComments;
    if (Object.keys(toSave).length > 0) {
      saveConfig(toSave as Parameters<typeof saveConfig>[0]);
    }
    json(res, { ok: true });
  } catch {
    json(res, { error: "Invalid request" }, 400);
  }
}

export async function handleReviewGitAdd(args: {
  req: IncomingMessage;
  res: ServerResponse;
  currentDiffType: DiffType;
  stageCwd: string | undefined;
  isPRMode: boolean;
}): Promise<void> {
  if (args.isPRMode || !(await canStageFiles(args.currentDiffType, args.stageCwd))) {
    json(args.res, { error: "Staging not available" }, 400);
    return;
  }
  try {
    const body = await parseBody(args.req);
    if (!Value.Check(GitAddSchema, body)) {
      json(args.res, { error: "Missing filePath" }, 400);
      return;
    }
    const payload: GitAddBody = body;
    if (payload.undo === true) {
      await unstageFile(args.currentDiffType, payload.filePath, args.stageCwd);
    } else {
      await stageFile(args.currentDiffType, payload.filePath, args.stageCwd);
    }
    json(args.res, { ok: true });
  } catch (err) {
    json(args.res, { error: errorMessage(err) || "Failed to stage file" }, 500);
  }
}

export async function handleReviewAiProxy(args: {
  req: IncomingMessage;
  res: ServerResponse;
  handler: (req: Request) => Promise<Response>;
}): Promise<void> {
  try {
    const webReq = await toWebRequest(args.req);
    const webRes = await args.handler(webReq);
    const headers: Record<string, string> = {};
    webRes.headers.forEach((value, key) => {
      headers[key] = value;
    });
    args.res.writeHead(webRes.status, headers);
    if (webRes.body === null) {
      args.res.end();
      return;
    }
    const nodeStream = Readable.from(webRes.body);
    nodeStream.pipe(args.res);
  } catch (err) {
    json(args.res, { error: errorMessage(err) || "AI endpoint error" }, 500);
  }
}

export async function handleReviewFeedback(args: {
  req: IncomingMessage;
  res: ServerResponse;
  deleteDraft: () => void;
  resolveDecision: (result: {
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }) => void;
}): Promise<void> {
  try {
    const body = await parseBody(args.req);
    if (!Value.Check(FeedbackSchema, body)) {
      json(args.res, { error: "Invalid request" }, 400);
      return;
    }
    const payload: FeedbackBody = body;
    args.deleteDraft();
    args.resolveDecision({
      approved: payload.approved ?? false,
      feedback: payload.feedback ?? "",
      annotations: payload.annotations ?? [],
      agentSwitch: payload.agentSwitch,
    });
    json(args.res, { ok: true });
  } catch (err) {
    json(args.res, { error: errorMessage(err) || "Failed to process feedback" }, 500);
  }
}
