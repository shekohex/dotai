import type { ClientCapabilities } from "../remote/schemas.js";

export const runtimeCapabilitiesSymbol = Symbol.for("@shekohex/agent/runtime-capabilities");

type RuntimeCapabilitiesSource =
  | ClientCapabilities
  | (() => ClientCapabilities | undefined)
  | undefined;

export function attachRuntimeCapabilities(
  target: unknown,
  source: RuntimeCapabilitiesSource,
): void {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    return;
  }
  Reflect.set(target, runtimeCapabilitiesSymbol, source);
}

export function getRuntimeCapabilities(context: {
  hasUI?: boolean;
  ui?: unknown;
}): ClientCapabilities | undefined {
  const fromContext = readRuntimeCapabilitiesSource(context);
  if (fromContext) {
    return fromContext;
  }

  const fromUi = readRuntimeCapabilitiesSource(context.ui);
  if (fromUi) {
    return fromUi;
  }

  if (context.hasUI === true) {
    return {
      protocolVersion: "1.0",
      primitives: {
        select: true,
        confirm: true,
        input: true,
        editor: true,
        custom: true,
        setWidget: true,
        setHeader: true,
        setFooter: true,
        setEditorComponent: true,
        onTerminalInput: true,
      },
    };
  }

  return undefined;
}

export function hasRuntimePrimitive(
  context: { hasUI?: boolean; ui?: unknown },
  primitive: keyof ClientCapabilities["primitives"],
): boolean {
  const capabilities = getRuntimeCapabilities(context);
  if (!capabilities) {
    return false;
  }
  return capabilities.primitives[primitive];
}

function readRuntimeCapabilitiesSource(target: unknown): ClientCapabilities | undefined {
  const targetRecord = toRecord(target);
  if (!targetRecord) {
    return undefined;
  }

  const source: unknown = Reflect.get(targetRecord, runtimeCapabilitiesSymbol);
  if (isRuntimeCapabilitiesGetter(source)) {
    const value = source();
    return isClientCapabilities(value) ? value : undefined;
  }
  return isClientCapabilities(source) ? source : undefined;
}

function isClientCapabilities(value: unknown): value is ClientCapabilities {
  const valueRecord = toRecord(value);
  if (!valueRecord) {
    return false;
  }

  const protocolVersion = valueRecord["protocolVersion"];
  const primitives = toRecord(valueRecord["primitives"]);
  if (protocolVersion !== "1.0") {
    return false;
  }
  if (!primitives) {
    return false;
  }

  return (
    typeof primitives["select"] === "boolean" &&
    typeof primitives["confirm"] === "boolean" &&
    typeof primitives["input"] === "boolean" &&
    typeof primitives["editor"] === "boolean" &&
    typeof primitives["custom"] === "boolean" &&
    typeof primitives["setWidget"] === "boolean" &&
    typeof primitives["setHeader"] === "boolean" &&
    typeof primitives["setFooter"] === "boolean" &&
    typeof primitives["setEditorComponent"] === "boolean" &&
    typeof primitives["onTerminalInput"] === "boolean"
  );
}

function isRuntimeCapabilitiesGetter(value: unknown): value is () => unknown {
  return typeof value === "function";
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return { ...value };
}
