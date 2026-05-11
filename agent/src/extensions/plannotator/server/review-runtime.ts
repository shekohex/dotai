import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { requestUrl } from "./review-local-deps.js";
import { dispatchReviewServerRequest } from "./review-server-dispatch.js";
import type { ReviewMutableState } from "./review-diff-routes.js";
import { errorMessage } from "../../../utils/error-message.js";

export function createReviewStateBridge(args: {
  reviewState: ReviewMutableState;
  getLocals: () => ReviewMutableState;
  setLocals: (state: ReviewMutableState) => void;
}) {
  function syncStateFromLocals(): void {
    Object.assign(args.reviewState, args.getLocals());
  }

  function syncLocalsFromState(): void {
    args.setLocals(args.reviewState);
  }

  return { syncStateFromLocals, syncLocalsFromState };
}

export function createReviewHttpServer(
  contextFactory: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) => Parameters<typeof dispatchReviewServerRequest>[0],
) {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = requestUrl(req);
        await dispatchReviewServerRequest(contextFactory(req, res, url));
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: errorMessage(error) }));
          return;
        }
        if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });
}
