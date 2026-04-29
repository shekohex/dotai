import type { MiddlewareHandler, Schema } from "hono";
import { Hono } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { describeRoute } from "hono-openapi";
import {
  ActiveToolsUpdateRequestSchema,
  AuthChallengeRequestSchema,
  AuthVerifyRequestSchema,
  BashExecuteRequestSchema,
  BashRecordRequestSchema,
  CompactRequestSchema,
  CreateSessionRequestSchema,
  ExtensionCustomEventRequestSchema,
  ForkSessionRequestSchema,
  FollowUpCommandRequestSchema,
  InterruptCommandRequestSchema,
  ModelUpdateRequestSchema,
  NavigateTreeRequestSchema,
  PromptCommandRequestSchema,
  SettingsUpdateRequestSchema,
  SessionParamsSchema,
  SessionSnapshotQuerySchema,
  SessionNameUpdateRequestSchema,
  SessionToolParamsSchema,
  SteerCommandRequestSchema,
  StreamReadQuerySchema,
  UiResponseRequestSchema,
} from "./schemas.js";
import { requireAuth } from "./routes/auth.js";
import {
  appSnapshotRouteDescription,
  archiveSessionRouteDescription,
  authChallengeRouteDescription,
  authVerifyRouteDescription,
  clearSessionQueueRouteDescription,
  createSessionRouteDescription,
  deleteSessionRouteDescription,
  emitSessionExtensionCustomEventRouteDescription,
  executeBashRouteDescription,
  forkSessionRouteDescription,
  followUpSessionRouteDescription,
  interruptSessionRouteDescription,
  navigateTreeRouteDescription,
  promptSessionRouteDescription,
  reloadSessionRouteDescription,
  readAppEventsStreamRouteDescription,
  readSessionEventsStreamRouteDescription,
  recordBashResultRouteDescription,
  renameSessionRouteDescription,
  restoreSessionRouteDescription,
  sessionSummaryRouteDescription,
  sessionSnapshotRouteDescription,
  sessionSyncRouteDescription,
  sessionToolDefinitionRouteDescription,
  sessionForkMessagesRouteDescription,
  sessionToolsRouteDescription,
  steerSessionRouteDescription,
  submitSessionUiResponseRouteDescription,
  abortBashRouteDescription,
  abortCompactionRouteDescription,
  compactSessionRouteDescription,
  updateSessionModelRouteDescription,
  updateSessionNameRouteDescription,
  updateSessionSettingsRouteDescription,
  updateSessionActiveToolsRouteDescription,
} from "./routes/descriptions.js";
import {
  handleAppSnapshot,
  handleArchiveSession,
  handleAbortBash,
  handleAbortCompaction,
  handleAuthChallenge,
  handleAuthVerify,
  handleClearSessionQueue,
  handleCompactSession,
  handleCreateSession,
  handleDeleteSession,
  handleEmitSessionExtensionCustomEvent,
  handleExecuteBash,
  handleForkSession,
  handleNavigateTree,
  handleRecordBashResult,
  handleRestoreSession,
  handleSessionSummary,
  handleSessionForkMessages,
  handleSessionSnapshot,
  handleSessionToolDefinition,
  handleSessionTools,
  handleReloadSession,
  handleSubmitSessionUiResponse,
} from "./routes/handlers.js";
import { createConnectionRoutes } from "./routes/connection-routes.js";
import { createRemoteKvRoutes } from "./kv/routes.js";
import {
  handleFollowUpSession,
  handleInterruptSession,
  handlePromptSession,
  handleRenameSession,
  handleSteerSession,
  handleUpdateSessionActiveTools,
  handleUpdateSessionModel,
  handleUpdateSessionName,
  handleUpdateSessionSettings,
} from "./routes/handlers-commands.js";
import { handleAppEventsStreamRead, handleSessionEventsStreamRead } from "./routes/stream-read.js";
import { handleSessionSync } from "./routes/session-sync.js";
import { assertType } from "./typebox.js";
import type { RemoteHonoEnv, RemoteRoutesDependencies } from "./routes/types.js";

type AuthMiddleware = MiddlewareHandler<RemoteHonoEnv>;

function registerAuthRoutes<S extends Schema, BasePath extends string>(
  app: Hono<RemoteHonoEnv, S, BasePath>,
  dependencies: RemoteRoutesDependencies,
) {
  const route1 = app.post(
    "/auth/challenge",
    describeRoute(authChallengeRouteDescription),
    tbValidator("json", AuthChallengeRequestSchema),
    (c) => handleAuthChallenge(c, dependencies, c.req.valid("json")),
  );
  return route1.post(
    "/auth/verify",
    describeRoute(authVerifyRouteDescription),
    tbValidator("json", AuthVerifyRequestSchema),
    (c) => handleAuthVerify(c, dependencies, c.req.valid("json")),
  );
}

function registerSnapshotRoutes<S extends Schema, BasePath extends string>(
  app: Hono<RemoteHonoEnv, S, BasePath>,
  dependencies: RemoteRoutesDependencies,
  needsAuth: AuthMiddleware,
) {
  const route3 = app.get(
    "/app/snapshot",
    describeRoute(appSnapshotRouteDescription),
    needsAuth,
    (c) => handleAppSnapshot(c, dependencies),
  );
  const route4 = route3.post(
    "/sessions",
    describeRoute(createSessionRouteDescription),
    needsAuth,
    tbValidator("json", CreateSessionRequestSchema),
    (c) => handleCreateSession(c, dependencies, c.req.valid("json")),
  );
  return route4
    .get(
      "/sessions/:sessionId/summary",
      describeRoute(sessionSummaryRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleSessionSummary(c, dependencies, sessionId);
      },
    )
    .get(
      "/sessions/:sessionId/snapshot",
      describeRoute(sessionSnapshotRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      tbValidator("query", SessionSnapshotQuerySchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        const query = c.req.valid("query");
        return handleSessionSnapshot(c, dependencies, sessionId, {
          entriesLimit:
            query.entriesLimit === undefined ? undefined : Number.parseInt(query.entriesLimit, 10),
          entriesOffset:
            query.entriesOffset === undefined
              ? undefined
              : Number.parseInt(query.entriesOffset, 10),
        });
      },
    )
    .post(
      "/sessions/:sessionId/archive",
      describeRoute(archiveSessionRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleArchiveSession(c, dependencies, sessionId);
      },
    )
    .post(
      "/sessions/:sessionId/restore",
      describeRoute(restoreSessionRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleRestoreSession(c, dependencies, sessionId);
      },
    )
    .delete(
      "/sessions/:sessionId",
      describeRoute(deleteSessionRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleDeleteSession(c, dependencies, sessionId);
      },
    )
    .get(
      "/sessions/:sessionId/fork-messages",
      describeRoute(sessionForkMessagesRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleSessionForkMessages(c, dependencies, sessionId);
      },
    )
    .post(
      "/sessions/:sessionId/fork",
      describeRoute(forkSessionRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      tbValidator("json", ForkSessionRequestSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleForkSession(c, dependencies, sessionId, c.req.valid("json"));
      },
    )
    .get(
      "/sessions/:sessionId/tools",
      describeRoute(sessionToolsRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleSessionTools(c, dependencies, sessionId);
      },
    )
    .get(
      "/sessions/:sessionId/tools/:toolName",
      describeRoute(sessionToolDefinitionRouteDescription),
      needsAuth,
      tbValidator("param", SessionToolParamsSchema),
      (c) => {
        const { sessionId, toolName } = c.req.valid("param");
        return handleSessionToolDefinition(c, dependencies, sessionId, toolName);
      },
    );
}

function registerSessionCommandRoutesA<S extends Schema, BasePath extends string>(
  app: Hono<RemoteHonoEnv, S, BasePath>,
  dependencies: RemoteRoutesDependencies,
  needsAuth: AuthMiddleware,
) {
  const route6 = app.post(
    "/sessions/:sessionId/prompt",
    describeRoute(promptSessionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", PromptCommandRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handlePromptSession(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route7 = route6.post(
    "/sessions/:sessionId/steer",
    describeRoute(steerSessionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", SteerCommandRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleSteerSession(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  return route7
    .post(
      "/sessions/:sessionId/follow-up",
      describeRoute(followUpSessionRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      tbValidator("json", FollowUpCommandRequestSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleFollowUpSession(c, dependencies, sessionId, c.req.valid("json"));
      },
    )
    .post(
      "/sessions/:sessionId/extension-event",
      describeRoute(emitSessionExtensionCustomEventRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      tbValidator("json", ExtensionCustomEventRequestSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleEmitSessionExtensionCustomEvent(
          c,
          dependencies,
          sessionId,
          c.req.valid("json"),
        );
      },
    );
}

function registerSessionCommandRoutesB<S extends Schema, BasePath extends string>(
  app: Hono<RemoteHonoEnv, S, BasePath>,
  dependencies: RemoteRoutesDependencies,
  needsAuth: AuthMiddleware,
) {
  const route9 = app.post(
    "/sessions/:sessionId/reload",
    describeRoute(reloadSessionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleReloadSession(c, dependencies, sessionId);
    },
  );
  const route10 = route9.post(
    "/sessions/:sessionId/interrupt",
    describeRoute(interruptSessionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", InterruptCommandRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleInterruptSession(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route11 = route10.post(
    "/sessions/:sessionId/active-tools",
    describeRoute(updateSessionActiveToolsRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", ActiveToolsUpdateRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleUpdateSessionActiveTools(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route12 = route11.post(
    "/sessions/:sessionId/model",
    describeRoute(updateSessionModelRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", ModelUpdateRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleUpdateSessionModel(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route13 = route12.post(
    "/sessions/:sessionId/navigate-tree",
    describeRoute(navigateTreeRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", NavigateTreeRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleNavigateTree(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  return route13.post(
    "/sessions/:sessionId/compact",
    describeRoute(compactSessionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", CompactRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleCompactSession(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
}

function registerSessionCommandRoutesC<S extends Schema, BasePath extends string>(
  app: Hono<RemoteHonoEnv, S, BasePath>,
  dependencies: RemoteRoutesDependencies,
  needsAuth: AuthMiddleware,
) {
  const route12 = app.post(
    "/sessions/:sessionId/rename",
    describeRoute(renameSessionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", SessionNameUpdateRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleRenameSession(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route13 = route12.post(
    "/sessions/:sessionId/session-name",
    describeRoute(updateSessionNameRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", SessionNameUpdateRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleUpdateSessionName(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route14 = route13.post(
    "/sessions/:sessionId/settings",
    describeRoute(updateSessionSettingsRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", SettingsUpdateRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      const payload: unknown = c.req.valid("json");
      assertType(SettingsUpdateRequestSchema, payload);
      return handleUpdateSessionSettings(c, dependencies, sessionId, payload);
    },
  );
  const route15 = route14.post(
    "/sessions/:sessionId/ui-response",
    describeRoute(submitSessionUiResponseRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", UiResponseRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleSubmitSessionUiResponse(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route16 = route15.post(
    "/sessions/:sessionId/clear-queue",
    describeRoute(clearSessionQueueRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleClearSessionQueue(c, dependencies, sessionId);
    },
  );
  const route17 = route16.post(
    "/sessions/:sessionId/abort-compaction",
    describeRoute(abortCompactionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleAbortCompaction(c, dependencies, sessionId);
    },
  );
  const route18 = route17.post(
    "/sessions/:sessionId/bash",
    describeRoute(executeBashRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", BashExecuteRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleExecuteBash(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  const route19 = route18.post(
    "/sessions/:sessionId/bash/result",
    describeRoute(recordBashResultRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", BashRecordRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleRecordBashResult(c, dependencies, sessionId, c.req.valid("json"));
    },
  );
  return route19.post(
    "/sessions/:sessionId/abort-bash",
    describeRoute(abortBashRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleAbortBash(c, dependencies, sessionId);
    },
  );
}

function registerStreamRoutes<S extends Schema, BasePath extends string>(
  app: Hono<RemoteHonoEnv, S, BasePath>,
  dependencies: RemoteRoutesDependencies,
  needsAuth: AuthMiddleware,
) {
  const route15 = app.get(
    "/streams/app-events",
    describeRoute(readAppEventsStreamRouteDescription),
    needsAuth,
    tbValidator("query", StreamReadQuerySchema),
    (c) => handleAppEventsStreamRead(c, dependencies, c.req.valid("query")),
  );
  return route15
    .get(
      "/streams/sessions/:sessionId/events",
      describeRoute(readSessionEventsStreamRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      tbValidator("query", StreamReadQuerySchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleSessionEventsStreamRead(c, dependencies, sessionId, c.req.valid("query"));
      },
    )
    .get(
      "/sessions/:sessionId/sync",
      describeRoute(sessionSyncRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleSessionSync(c, dependencies, sessionId);
      },
    );
}

export function createV1Routes(dependencies: RemoteRoutesDependencies) {
  const v1 = new Hono<RemoteHonoEnv>();
  const needsAuth = requireAuth(dependencies.auth);
  const withAuthRoutes = registerAuthRoutes(v1, dependencies);
  const withConnectionRoutes = withAuthRoutes.route(
    "/connections",
    createConnectionRoutes(dependencies, needsAuth),
  );
  const withKvRoutes = withConnectionRoutes.route(
    "/kv",
    createRemoteKvRoutes(dependencies, needsAuth),
  );
  const withSnapshotRoutes = registerSnapshotRoutes(withKvRoutes, dependencies, needsAuth);
  const withSessionCommandsA = registerSessionCommandRoutesA(
    withSnapshotRoutes,
    dependencies,
    needsAuth,
  );
  const withSessionCommandsB = registerSessionCommandRoutesB(
    withSessionCommandsA,
    dependencies,
    needsAuth,
  );
  const withSessionCommandsC = registerSessionCommandRoutesC(
    withSessionCommandsB,
    dependencies,
    needsAuth,
  );
  return registerStreamRoutes(withSessionCommandsC, dependencies, needsAuth);
}

export type RemoteV1RoutesApp = ReturnType<typeof createV1Routes>;
export type { RemoteHonoEnv } from "./routes/types.js";
