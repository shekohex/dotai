import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isUnknownRecord } from "../../utils/unknown-value.js";
import { parseScreenCaptureResult } from "./pairing/schemas.js";
import { presentImageToModel } from "../view-image.js";

export const MAX_CAPTURE_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_SCREEN_CAPTURE_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const JPEG_MIME_TYPE = "image/jpeg";

const LookAtParams = Type.Object({}, { additionalProperties: false });

export interface ScreenCaptureConnection {
  readonly open: boolean;
  readonly supportsScreenCapture: boolean;
  request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export type LiveScreenCaptureDetails = {
  path: string;
  mimeType: typeof JPEG_MIME_TYPE;
  width: number;
  height: number;
  displayId: string;
  timestamp: number;
  byteSize: number;
  sha256: string;
  describedBy?: string;
};

type LiveScreenCaptureSessionOptions = {
  requestTimeoutMs?: number;
  temporaryRoot?: string;
};

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= data.length) return undefined;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) return undefined;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (segmentLength < 7) return undefined;
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return undefined;
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const paddingStart = value.indexOf("=");
  const contentEnd = paddingStart === -1 ? value.length : paddingStart;
  if (value.length - contentEnd > 2) return false;
  for (let index = contentEnd; index < value.length; index += 1) {
    if (value[index] !== "=") return false;
  }
  return true;
}

function decodeCaptureImage(value: unknown): {
  image: ImageContent;
  data: Buffer;
  metadata: Omit<LiveScreenCaptureDetails, "path">;
} {
  const encodedBytes =
    isUnknownRecord(value) && typeof value.data === "string"
      ? Buffer.byteLength(value.data)
      : undefined;
  const result = parseScreenCaptureResult(value);
  if (result === undefined) throw new Error("Pi Live app returned invalid screen.capture metadata");
  if (result.mimeType !== JPEG_MIME_TYPE) {
    throw new Error(`Pi Live screen capture must use ${JPEG_MIME_TYPE}`);
  }
  if (!isStrictBase64(result.data)) {
    throw new Error("Pi Live app returned invalid Base64 screen capture data");
  }
  const data = Buffer.from(result.data, "base64");
  if (data.toString("base64") !== result.data) {
    throw new Error("Pi Live app returned invalid Base64 screen capture data");
  }
  if (data.byteLength > MAX_CAPTURE_IMAGE_BYTES) {
    throw new Error("Pi Live screen capture decoded image is oversized");
  }
  if (encodedBytes !== undefined && encodedBytes > MAX_SCREEN_CAPTURE_FRAME_BYTES) {
    throw new Error("Pi Live screen capture encoded response is oversized");
  }
  if (data.byteLength !== result.byteSize) {
    throw new Error("Pi Live screen capture byteSize does not match decoded data");
  }
  if (
    data.length < 4 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data.at(-2) !== 0xff ||
    data.at(-1) !== 0xd9
  ) {
    throw new Error("Pi Live screen capture has invalid JPEG magic");
  }
  const dimensions = jpegDimensions(data);
  if (dimensions === undefined)
    throw new Error("Pi Live screen capture has invalid JPEG dimensions");
  if (dimensions.width !== result.width || dimensions.height !== result.height) {
    throw new Error("Pi Live screen capture declared dimensions do not match JPEG data");
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== result.sha256) {
    throw new Error("Pi Live screen capture sha256 does not match decoded data");
  }
  return {
    image: { type: "image", data: result.data, mimeType: JPEG_MIME_TYPE },
    data,
    metadata: {
      mimeType: JPEG_MIME_TYPE,
      width: result.width,
      height: result.height,
      displayId: result.displayId,
      timestamp: result.timestamp,
      byteSize: result.byteSize,
      sha256: result.sha256,
    },
  };
}

export class LiveScreenCaptureSession {
  readonly #sessionId: string;
  readonly #requestTimeoutMs: number;
  readonly #temporaryRoot: string;
  #connection: ScreenCaptureConnection | undefined;
  #generation = 0;
  #directory: string | undefined;
  #captureActive = false;
  #closed = false;

  constructor(sessionId: string, options: LiveScreenCaptureSessionOptions = {}) {
    this.#sessionId = sessionId.replaceAll(/[^A-Za-z\d_-]/g, "-").slice(0, 64) || "session";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.#temporaryRoot = options.temporaryRoot ?? tmpdir();
  }

  attach(connection: ScreenCaptureConnection): void {
    if (this.#closed) throw new Error("Pi Live screen capture session has ended");
    this.#generation += 1;
    this.#connection = connection;
  }

  async capture(signal?: AbortSignal): Promise<LiveScreenCaptureDetails & { image: ImageContent }> {
    if (signal?.aborted === true) throw signal.reason;
    if (this.#closed) throw new Error("Pi Live screen capture session has ended");
    const connection = this.#connection;
    if (connection?.open !== true) {
      throw new Error("Pi Live screen capture is unavailable: no active paired Pi Live app");
    }
    if (!connection.supportsScreenCapture) {
      throw new Error(
        "Paired Pi Live app does not support screenCapture; update the app to capture the display",
      );
    }
    if (this.#captureActive) throw new Error("Pi Live screen capture is already in progress");
    this.#captureActive = true;
    const generation = this.#generation;
    let path: string | undefined;
    try {
      const value = await connection.request("screen.capture", {}, this.#requestTimeoutMs, signal);
      if (
        this.#closed ||
        generation !== this.#generation ||
        connection !== this.#connection ||
        !connection.open
      ) {
        throw new Error("Pi Live app returned a screen capture for a stale live session");
      }
      const capture = decodeCaptureImage(value);
      const directory = await this.#captureDirectory();
      path = join(directory, `${randomUUID()}.jpg`);
      await writeFile(path, capture.data, { flag: "wx", mode: 0o600 });
      return { path, ...capture.metadata, image: capture.image };
    } catch (error) {
      if (path !== undefined) await rm(path, { force: true }).catch(() => {});
      throw error;
    } finally {
      this.#captureActive = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#connection = undefined;
    const directory = this.#directory;
    this.#directory = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }

  async #captureDirectory(): Promise<string> {
    if (this.#directory !== undefined) return this.#directory;
    const directory = await mkdtemp(join(this.#temporaryRoot, `pi-live-${this.#sessionId}-`));
    await chmod(directory, 0o700);
    this.#directory = directory;
    return directory;
  }
}

export function createLookAtToolDefinition(getSession: () => LiveScreenCaptureSession | undefined) {
  return defineTool<typeof LookAtParams, LiveScreenCaptureDetails>({
    name: "look_at",
    label: "Look At Display",
    description: "Capture and inspect the full current display from the paired Pi Live macOS app.",
    promptSnippet: "Capture the current display from the paired Pi Live app",
    promptGuidelines: [
      "Use look_at only when the user explicitly asks you to inspect the current screen; never capture automatically.",
    ],
    parameters: LookAtParams,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const session = getSession();
      if (session === undefined) {
        throw new Error("Pi Live screen capture is unavailable: no active paired Pi Live app");
      }
      const capture = await session.capture(signal);
      const { image, ...details } = capture;
      const directText = `Captured display ${details.displayId}: ${details.width}x${details.height} JPEG (${details.byteSize} bytes) at ${details.path}`;
      const presentation = await presentImageToModel(image, directText, signal, ctx);
      return {
        content: presentation.content,
        details: {
          ...details,
          ...(presentation.describedBy === undefined
            ? {}
            : { describedBy: presentation.describedBy }),
        },
      };
    },
  });
}
