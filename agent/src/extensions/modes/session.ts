import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../../utils/unknown-data.js";

type SessionPersistenceReader = {
  isPersisted: () => boolean;
};

type SessionPersistenceMethod = (this: unknown) => unknown;

function isSessionPersistenceMethod(value: unknown): value is SessionPersistenceMethod {
  return typeof value === "function";
}

function readSessionPersistenceReader(
  sessionManager: ExtensionContext["sessionManager"],
): SessionPersistenceReader | undefined {
  const record = asRecord(sessionManager);
  if (!record) {
    return undefined;
  }

  const isPersisted = record.isPersisted;
  if (!isSessionPersistenceMethod(isPersisted)) {
    return undefined;
  }

  return {
    isPersisted: () => {
      const result = isPersisted.call(sessionManager);
      return typeof result === "boolean" ? result : false;
    },
  };
}

export function isEphemeralSession(ctx: ExtensionContext): boolean {
  const sessionPersistenceReader = readSessionPersistenceReader(ctx.sessionManager);
  if (!sessionPersistenceReader) {
    return false;
  }

  return !sessionPersistenceReader.isPersisted();
}
