import type { ReviewServerResult } from "./serverReview.js";
import { createReviewHttpServer } from "./review-runtime.js";
import { listenOnPort } from "./review-local-deps.js";

export async function startReviewLifecycle(args: {
  createDispatchContext: Parameters<typeof createReviewHttpServer>[0];
  getServerUrl: () => string;
  setServerUrl: (url: string) => void;
  isRemote: boolean;
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  killAll: () => void;
  disposeAi: () => void;
  onCleanup?: () => void | Promise<void>;
  decisionPromise: ReturnType<ReviewServerResult["waitForDecision"]>;
}): Promise<
  Omit<ReviewServerResult, "waitForDecision"> & {
    waitForDecision: ReviewServerResult["waitForDecision"];
  }
> {
  const server = createReviewHttpServer(args.createDispatchContext);
  const { port, portSource } = await listenOnPort(server);
  const serverUrl = `http://localhost:${port}`;
  args.setServerUrl(serverUrl);
  const exitHandler = () => {
    args.killAll();
  };
  process.once("exit", exitHandler);
  if (args.onReady) {
    args.onReady(serverUrl, args.isRemote, port);
  }
  return {
    port,
    portSource,
    url: serverUrl,
    isRemote: args.isRemote,
    waitForDecision: () => args.decisionPromise,
    stop: () => {
      process.removeListener("exit", exitHandler);
      args.killAll();
      args.disposeAi();
      server.close();
      if (args.onCleanup !== undefined) {
        try {
          const result = args.onCleanup();
          if (result instanceof Promise) result.catch(() => {});
        } catch {}
      }
    },
  };
}
