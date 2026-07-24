import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const CHATGPT_BUNDLE_ID = "com.openai.codex";

const CodexDeviceCheckResultSchema = Type.Object({
  supported: Type.Boolean(),
  tokenBase64: Type.Optional(Type.String()),
  latencyMs: Type.Optional(Type.Number({ minimum: 0 })),
  locale: Type.String({ minLength: 1, maxLength: 64 }),
  timezone: Type.String({ minLength: 1, maxLength: 64 }),
  appSessionId: Type.String({ minLength: 1, maxLength: 128 }),
});

export type CodexDeviceCheckResult = Static<typeof CodexDeviceCheckResultSchema>;

function cborHeader(major: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid CBOR length: ${value}`);
  if (value < 24) return Buffer.from([major + value]);
  if (value <= 0xff) return Buffer.from([major + 24, value]);
  if (value <= 0xffff) {
    const output = Buffer.allocUnsafe(3);
    output[0] = major + 25;
    output.writeUInt16BE(value, 1);
    return output;
  }
  if (value <= 0xffff_ffff) {
    const output = Buffer.allocUnsafe(5);
    output[0] = major + 26;
    output.writeUInt32BE(value, 1);
    return output;
  }
  throw new Error(`CBOR length is too large: ${value}`);
}

function cborUnsigned(value: number): Buffer {
  return cborHeader(0, value);
}

function cborText(value: string): Buffer {
  const text = Buffer.from(value, "utf8");
  return Buffer.concat([cborHeader(96, text.length), text]);
}

function cborMap(entries: ReadonlyArray<readonly [Buffer, Buffer]>): Buffer {
  const values: Buffer[] = [cborHeader(160, entries.length)];
  for (const [key, value] of entries) values.push(key, value);
  return Buffer.concat(values);
}

function attestationSignals(result: CodexDeviceCheckResult): Buffer {
  const preferredLanguages = Buffer.concat([cborHeader(128, 1), cborText(result.locale)]);
  return cborMap([
    [cborUnsigned(0), cborUnsigned(1)],
    [cborUnsigned(1), preferredLanguages],
    [cborUnsigned(2), cborText(result.locale)],
    [cborUnsigned(3), cborText(result.timezone)],
    [cborUnsigned(4), cborUnsigned(0)],
    [cborUnsigned(5), cborUnsigned(1)],
    [cborUnsigned(6), cborText(result.appSessionId)],
  ]);
}

function buildClientAttestation(result: CodexDeviceCheckResult): string {
  const entries: Array<readonly [Buffer, Buffer]> = [];
  if (result.supported && result.tokenBase64 !== undefined && result.tokenBase64.length > 0) {
    entries.push([cborText("token"), cborText(result.tokenBase64)]);
  } else {
    entries.push([cborText("error_code"), cborUnsigned(result.supported ? 4 : 3)]);
  }
  entries.push([cborText("bundle_id"), cborText(CHATGPT_BUNDLE_ID)]);
  const signals = attestationSignals(result);
  entries.push([cborText("f"), Buffer.concat([cborHeader(64, signals.length), signals])]);
  if (result.latencyMs !== undefined) {
    const latency = Buffer.allocUnsafe(9);
    latency[0] = 0xfb;
    latency.writeDoubleBE(result.latencyMs, 1);
    entries.push([cborText("t"), latency]);
  }
  return `v1.${cborMap(entries).toString("base64url")}`;
}

/**
 * Parses DeviceCheck output returned by the paired macOS app.
 *
 * @param {unknown} value Untrusted JSON-RPC result.
 * @returns {CodexDeviceCheckResult} Validated DeviceCheck result.
 */
export function parseCodexDeviceCheckResult(value: unknown): CodexDeviceCheckResult {
  if (!Value.Check(CodexDeviceCheckResultSchema, value)) {
    throw new Error("Pi Live app returned an invalid Codex attestation response");
  }
  return Value.Parse(CodexDeviceCheckResultSchema, value);
}

/**
 * Builds the OMP-compatible `x-oai-attestation` header value.
 *
 * @param {CodexDeviceCheckResult} result Validated macOS DeviceCheck result.
 * @returns {string} Serialized attestation header value.
 */
export function buildCodexAttestation(result: CodexDeviceCheckResult): string {
  return JSON.stringify({ v: 1, s: 0, t: buildClientAttestation(result) });
}
