import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "../utils/error-message.js";
import { asRecord, readNumber, readString } from "../utils/unknown-data.js";
import type { WebhookConfig } from "./config.js";
import { parseJsonValue } from "./json.js";
import type { ConductorOrchestrator } from "./orchestrator.js";
import { GITHUB_RATE_LIMIT_BACKOFF_MS, isRateLimitError } from "./rate-limit.js";
import { ReconcileScopeSchema, type ReconcileScope } from "./reconcile-scope.js";
import type { ConductorStore } from "./store/types.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_WEBHOOK_DELIVERY_ATTEMPTS = 3;
const WEBHOOK_RETRY_BASE_DELAY_MS = 60_000;
let pendingDeliveryProcessing: Promise<void> | undefined;
let pendingDeliveryRerun = false;
let webhookBackoffUntil = 0;

export const SUPPORTED_WEBHOOK_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
  "status",
  "workflow_run",
  "projects_v2_item",
] as const;
const SUPPORTED_WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(SUPPORTED_WEBHOOK_EVENTS);

export const WebhookMetadataSchema = Type.Object({
  deliveryId: Type.String(),
  eventName: Type.String(),
  signature: Type.String(),
});

const WebhookRepositoryPayloadSchema = Type.Object({
  repository: Type.Optional(Type.Object({ full_name: Type.Optional(Type.String()) })),
});

export type WebhookMetadata = Static<typeof WebhookMetadataSchema>;

export async function resolveWebhookSecret(config: WebhookConfig): Promise<string> {
  if ("env" in config.secret) {
    const value = process.env[config.secret.env];
    if (value === undefined || value.length === 0) {
      throw new Error(`Webhook secret env var is not set: ${config.secret.env}`);
    }
    return value;
  }
  const value = (await readFile(config.secret.file, "utf8")).trim();
  if (value.length === 0) throw new Error(`Webhook secret file is empty: ${config.secret.file}`);
  return value;
}

export function verifyWebhookSignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export async function serveWebhook(input: {
  config: WebhookConfig;
  store: ConductorStore;
  orchestrator: ConductorOrchestrator;
  repositories: Array<{ owner: string; repo: string }>;
}): Promise<{ port: number; close(): Promise<void> }> {
  const secret = await resolveWebhookSecret(input.config);
  const server = createServer((request, response) => {
    void handleWebhookRequest({ ...input, secret, request, response }).catch((error: unknown) => {
      response.statusCode = error instanceof WebhookHttpError ? error.statusCode : 500;
      response.end(errorMessage(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(input.config.port, input.config.host, resolve);
  });

  return {
    port: readServerPort(server),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

async function handleWebhookRequest(input: {
  config: WebhookConfig;
  store: ConductorStore;
  orchestrator: ConductorOrchestrator;
  repositories: Array<{ owner: string; repo: string }>;
  secret: string;
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> {
  if (input.request.method !== "POST" || input.request.url !== input.config.path) {
    input.response.statusCode = 404;
    input.response.end("not found");
    return;
  }

  const body = await readRequestBody(input.request);
  const metadata = Value.Parse(WebhookMetadataSchema, {
    deliveryId: headerValue(input.request, "x-github-delivery"),
    eventName: headerValue(input.request, "x-github-event"),
    signature: headerValue(input.request, "x-hub-signature-256"),
  });

  if (!verifyWebhookSignature(input.secret, body, metadata.signature)) {
    input.response.statusCode = 401;
    input.response.end("invalid signature");
    return;
  }

  if (metadata.eventName === "ping") {
    input.response.statusCode = 200;
    input.response.end("pong");
    return;
  }

  if (!isSupportedWebhookEvent(metadata.eventName)) {
    input.response.statusCode = 202;
    input.response.end("ignored unsupported event");
    return;
  }

  const parsedPayload = parseWebhookPayload(body);
  const repositoryFullName = readWebhookRepositoryFullName(parsedPayload);
  if (
    repositoryFullName !== undefined &&
    !isManagedRepository(repositoryFullName, input.repositories)
  ) {
    input.response.statusCode = 202;
    input.response.end("ignored unmanaged repository");
    return;
  }

  const scope = readWebhookReconcileScope(metadata.eventName, parsedPayload);
  const recorded = await input.store.recordDelivery({
    deliveryId: metadata.deliveryId,
    eventName: metadata.eventName,
    receivedAt: new Date().toISOString(),
    status: "received",
    metadata: {
      path: input.config.path,
      repositoryFullName,
      ...(scope === undefined ? {} : { scope }),
    },
  });
  const existing = recorded ? undefined : await input.store.getDelivery(metadata.deliveryId);
  input.response.statusCode = recorded ? 202 : 200;
  input.response.end(recorded ? "accepted" : "duplicate");
  if (recorded || existing?.status === "failed") {
    void processPendingWebhookDeliveries({
      store: input.store,
      orchestrator: input.orchestrator,
    }).catch(() => {});
  }
}

export function processPendingWebhookDeliveries(input: {
  store: ConductorStore;
  orchestrator: ConductorOrchestrator;
  onError?: (message: string) => void;
}): Promise<void> {
  if (pendingDeliveryProcessing !== undefined) {
    pendingDeliveryRerun = true;
    return pendingDeliveryProcessing;
  }
  pendingDeliveryProcessing = processPendingWebhookDeliveriesLoop(input).finally(() => {
    pendingDeliveryProcessing = undefined;
  });
  return pendingDeliveryProcessing;
}

async function processPendingWebhookDeliveriesLoop(input: {
  store: ConductorStore;
  orchestrator: ConductorOrchestrator;
  onError?: (message: string) => void;
}): Promise<void> {
  do {
    pendingDeliveryRerun = false;
    await processPendingWebhookDeliveriesOnce(input);
  } while (pendingDeliveryRerun);
}

async function processPendingWebhookDeliveriesOnce(input: {
  store: ConductorStore;
  orchestrator: ConductorOrchestrator;
  onError?: (message: string) => void;
}): Promise<void> {
  if (Date.now() < webhookBackoffUntil) return;
  const processing = await input.store.listDeliveriesByStatus("processing");
  await markExhaustedProcessingDeliveries(input.store, processing);
  const deliveries = [
    ...(await input.store.listDeliveriesByStatus("received")),
    ...processing.filter((delivery) => (delivery.attempts ?? 0) < MAX_WEBHOOK_DELIVERY_ATTEMPTS),
    ...(await input.store.listDeliveriesByStatus("failed")).filter(
      (delivery) =>
        (delivery.attempts ?? 0) < MAX_WEBHOOK_DELIVERY_ATTEMPTS &&
        (delivery.nextAttemptAt === undefined || Date.parse(delivery.nextAttemptAt) <= Date.now()),
    ),
  ];
  for (const delivery of deliveries) {
    try {
      await processRecordedDelivery(
        input.store,
        input.orchestrator,
        delivery.deliveryId,
        input.onError,
      );
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      webhookBackoffUntil = Date.now() + GITHUB_RATE_LIMIT_BACKOFF_MS;
      input.onError?.(
        `Conductor webhook delivery processing backed off after GitHub rate limit until ${new Date(webhookBackoffUntil).toISOString()}\n`,
      );
      throw error;
    }
  }
}

async function markExhaustedProcessingDeliveries(
  store: ConductorStore,
  deliveries: Awaited<ReturnType<ConductorStore["listDeliveriesByStatus"]>>,
): Promise<void> {
  for (const delivery of deliveries) {
    const attempts = delivery.attempts ?? 0;
    if (attempts < MAX_WEBHOOK_DELIVERY_ATTEMPTS) continue;
    await store.markDeliveryStatus(delivery.deliveryId, "failed", {
      attempts,
      lastError: "Webhook delivery exceeded max attempts while processing",
    });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookHttpError(413, "payload too large");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const buffer = Buffer.from(value);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) throw new WebhookHttpError(413, "payload too large");
      chunks.push(buffer);
      continue;
    }
    throw new Error("Webhook request body contained unsupported chunk type");
  }
  return Buffer.concat(chunks);
}

async function processRecordedDelivery(
  store: ConductorStore,
  orchestrator: ConductorOrchestrator,
  deliveryId: string,
  onError: ((message: string) => void) | undefined,
): Promise<void> {
  try {
    const delivery = await store.getDelivery(deliveryId);
    if (delivery === undefined) throw new Error(`Webhook delivery not found: ${deliveryId}`);
    const attempts = (delivery.attempts ?? 0) + 1;
    await store.markDeliveryStatus(deliveryId, "processing", {
      attempts,
    });
    await orchestrator.reconcile(readDeliveryScope(delivery));
    await store.markDeliveryStatus(deliveryId, "processed", {
      processedAt: new Date().toISOString(),
    });
  } catch (error) {
    try {
      const delivery = await store.getDelivery(deliveryId);
      const attempts = delivery?.attempts ?? 1;
      await store.markDeliveryStatus(deliveryId, "failed", {
        attempts,
        lastError: errorMessage(error),
        nextAttemptAt: nextAttemptAt(error, attempts),
      });
    } catch (innerError) {
      onError?.(
        `Conductor webhook delivery failure update failed for ${deliveryId}: ${errorMessage(innerError)}\n`,
      );
    }
    if (isRateLimitError(error)) throw error;
  }
}

function parseWebhookPayload(body: Buffer): unknown {
  return parseJsonValue(body.toString("utf8"), "webhook payload");
}

function readWebhookRepositoryFullName(payload: unknown): string | undefined {
  try {
    const parsed = Value.Parse(WebhookRepositoryPayloadSchema, payload);
    return parsed.repository?.full_name;
  } catch {
    return undefined;
  }
}

export function readWebhookReconcileScope(
  eventName: string,
  payload: unknown,
): ReconcileScope | undefined {
  const repository = readWebhookRepositoryFullName(payload);
  const base = repositoryScope(repository, eventName);
  const record = asRecord(payload);
  const issue = asRecord(record?.issue);
  const pullRequest = readPullRequestSummary(record?.pull_request);
  if (pullRequest !== undefined) {
    return parseScope({
      ...base,
      prNumber: pullRequest.number,
      branch: pullRequest.headRefName,
      pullRequest,
    });
  }
  const checkPullRequest =
    readCheckPullRequest(record?.check_run) ??
    readCheckPullRequest(record?.check_suite) ??
    readCheckPullRequest(record?.workflow_run);
  if (checkPullRequest !== undefined) return parseScope({ ...base, ...checkPullRequest });
  const statusBranch = readStatusBranch(record);
  if (statusBranch !== undefined) return parseScope({ ...base, branch: statusBranch });
  const issueNumber = readNumber(issue?.number);
  if (issueNumber !== undefined && issue?.pull_request !== undefined) {
    return parseScope({ ...base, prNumber: issueNumber });
  }
  if (issueNumber !== undefined) return parseScope({ ...base, issueNumber });
  const projectItemId = readString(asRecord(record?.projects_v2_item)?.id);
  if (projectItemId !== undefined) return parseScope({ ...base, projectItemId });
  return base.owner === undefined || base.repo === undefined ? undefined : parseScope(base);
}

function readStatusBranch(payload: Record<string, unknown> | undefined): string | undefined {
  const branches = Array.isArray(payload?.branches) ? payload.branches : [];
  return readString(asRecord(branches[0])?.name);
}

function readPullRequestSummary(value: unknown): ReconcileScope["pullRequest"] {
  const pullRequest = asRecord(value);
  if (pullRequest === undefined) return undefined;
  const number = readNumber(pullRequest?.number);
  const url = readString(pullRequest?.html_url) ?? readString(pullRequest?.url);
  const headRefName = readString(asRecord(pullRequest?.head)?.ref);
  const state = readString(pullRequest?.state);
  if (
    number === undefined ||
    url === undefined ||
    headRefName === undefined ||
    state === undefined
  ) {
    return undefined;
  }
  const mergedAt = readString(pullRequest?.merged_at);
  const linkedIssueNumbers = readWebhookLinkedIssueNumbers(pullRequest);
  return Value.Parse(ReconcileScopeSchema.properties.pullRequest, {
    number,
    url,
    headRefName,
    state: pullRequest.merged === true ? "MERGED" : state.toUpperCase(),
    isDraft: pullRequest.draft === true,
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(linkedIssueNumbers.length === 0 ? {} : { linkedIssueNumbers }),
  });
}

function readCheckPullRequest(value: unknown): Partial<ReconcileScope> | undefined {
  const record = asRecord(value);
  const pullRequests = Array.isArray(record?.pull_requests) ? record.pull_requests : [];
  const first = asRecord(pullRequests[0]);
  const prNumber = readNumber(first?.number);
  const branch = readString(first?.head_branch) ?? readString(asRecord(first?.head)?.ref);
  if (prNumber === undefined && branch === undefined) return undefined;
  return {
    ...(prNumber === undefined ? {} : { prNumber }),
    ...(branch === undefined ? {} : { branch }),
  };
}

function readWebhookLinkedIssueNumbers(pullRequest: Record<string, unknown>): number[] {
  const linked = Array.isArray(pullRequest.closing_issues_references)
    ? pullRequest.closing_issues_references
    : [];
  return linked.flatMap((entry) => {
    const number = readNumber(asRecord(entry)?.number);
    return number === undefined ? [] : [number];
  });
}

function repositoryScope(
  fullName: string | undefined,
  reason: string,
): Pick<ReconcileScope, "owner" | "repo" | "reason"> {
  const [owner, repo] = fullName?.split("/") ?? [];
  return {
    ...(owner === undefined || repo === undefined ? {} : { owner, repo }),
    reason,
  };
}

function parseScope(scope: ReconcileScope): ReconcileScope {
  return Value.Parse(ReconcileScopeSchema, scope);
}

function readDeliveryScope(delivery: {
  metadata: Record<string, unknown>;
}): ReconcileScope | undefined {
  const scope = delivery.metadata.scope;
  return scope === undefined ? undefined : Value.Parse(ReconcileScopeSchema, scope);
}

function nextAttemptAt(error: unknown, attempts: number): string {
  const delayMs = isRateLimitError(error)
    ? GITHUB_RATE_LIMIT_BACKOFF_MS
    : Math.min(
        WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
        GITHUB_RATE_LIMIT_BACKOFF_MS,
      );
  return new Date(Date.now() + jitterDelay(delayMs)).toISOString();
}

function jitterDelay(delayMs: number): number {
  return Math.round(delayMs * (0.75 + Math.random() * 0.5));
}

function isManagedRepository(
  fullName: string,
  repositories: Array<{ owner: string; repo: string }>,
): boolean {
  return repositories.some(
    (repo) => `${repo.owner}/${repo.repo}`.toLowerCase() === fullName.toLowerCase(),
  );
}

function isSupportedWebhookEvent(eventName: string): boolean {
  return SUPPORTED_WEBHOOK_EVENT_SET.has(eventName);
}

function readServerPort(server: { address(): string | { port: number } | null }): number {
  const address = server.address();
  if (typeof address === "object" && address !== null) return address.port;
  return 0;
}

class WebhookHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
