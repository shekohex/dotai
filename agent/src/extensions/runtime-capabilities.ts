import { Value } from "@sinclair/typebox/value";
import { ClientCapabilitiesSchema, type ClientCapabilities } from "../remote/schemas.js";

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

  writeObjectProperty(target, runtimeCapabilitiesSymbol, source);
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
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    return undefined;
  }

  const source = readObjectProperty(target, runtimeCapabilitiesSymbol);
  if (isRuntimeCapabilitiesGetter(source)) {
    const value = source();
    return isClientCapabilities(value) ? value : undefined;
  }
  return isClientCapabilities(source) ? source : undefined;
}

function isClientCapabilities(value: unknown): value is ClientCapabilities {
  return Value.Check(ClientCapabilitiesSchema, value);
}

function isRuntimeCapabilitiesGetter(value: unknown): value is () => unknown {
  return typeof value === "function";
}

function readObjectProperty(target: object, key: PropertyKey): unknown {
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

function writeObjectProperty(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}
