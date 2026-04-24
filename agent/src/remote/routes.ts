import type { MiddlewareHandler, Schema } from "hono";
import { Hono } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { describeRoute } from "hono-openapi";
import {
  ActiveToolsUpdateRequestSchema,
  AuthChallengeRequestSchema,
  AuthVerifyRequestSchema,
  CreateSessionRequestSchema,
  FollowUpCommandRequestSchema,
  InterruptCommandRequestSchema,
  ModelUpdateRequestSchema,
  PromptCommandRequestSchema,
  SettingsUpdateRequestSchema,
  SessionParamsSchema,
  SessionNameUpdateRequestSchema,
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
  followUpSessionRouteDescription,
  interruptSessionRouteDescription,
  promptSessionRouteDescription,
  reloadSessionRouteDescription,
  readAppEventsStreamRouteDescription,
  readSessionEventsStreamRouteDescription,
  restoreSessionRouteDescription,
  sessionSummaryRouteDescription,
  sessionSnapshotRouteDescription,
  sessionToolsRouteDescription,
  steerSessionRouteDescription,
  submitSessionUiResponseRouteDescription,
  updateSessionModelRouteDescription,
  updateSessionNameRouteDescription,
  updateSessionSettingsRouteDescription,
  updateSessionActiveToolsRouteDescription,
} from "./routes/descriptions.js";
import {
  handleAppSnapshot,
  handleArchiveSession,
  handleAuthChallenge,
  handleAuthVerify,
  handleClearSessionQueue,
  handleCreateSession,
  handleDeleteSession,
  handleRestoreSession,
  handleSessionSummary,
  handleSessionSnapshot,
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
  handleSteerSession,
  handleUpdateSessionActiveTools,
  handleUpdateSessionModel,
  handleUpdateSessionName,
  handleUpdateSessionSettings,
} from "./routes/handlers-commands.js";
import { handleAppEventsStreamRead, handleSessionEventsStreamRead } from "./routes/stream-read.js";
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
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleSessionSnapshot(c, dependencies, sessionId);
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
      "/sessions/:sessionId/tools",
      describeRoute(sessionToolsRouteDescription),
      needsAuth,
      tbValidator("param", SessionParamsSchema),
      (c) => {
        const { sessionId } = c.req.valid("param");
        return handleSessionTools(c, dependencies, sessionId);
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
  return route7.post(
    "/sessions/:sessionId/follow-up",
    describeRoute(followUpSessionRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("json", FollowUpCommandRequestSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleFollowUpSession(c, dependencies, sessionId, c.req.valid("json"));
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
  return route11.post(
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
}

function registerSessionCommandRoutesC<S extends Schema, BasePath extends string>(
  app: Hono<RemoteHonoEnv, S, BasePath>,
  dependencies: RemoteRoutesDependencies,
  needsAuth: AuthMiddleware,
) {
  const route12 = app.post(
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
  const route13 = route12.post(
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
  const route14 = route13.post(
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
  return route14.post(
    "/sessions/:sessionId/clear-queue",
    describeRoute(clearSessionQueueRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleClearSessionQueue(c, dependencies, sessionId);
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
  return route15.get(
    "/streams/sessions/:sessionId/events",
    describeRoute(readSessionEventsStreamRouteDescription),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("query", StreamReadQuerySchema),
    (c) => {
      const { sessionId } = c.req.valid("param");
      return handleSessionEventsStreamRead(c, dependencies, sessionId, c.req.valid("query"));
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
