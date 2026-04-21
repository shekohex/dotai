import { Type, type Static } from "@sinclair/typebox";

export type RemoteKvScope = "global" | "user";

export type RemoteKvReadResult = {
  scope: RemoteKvScope;
  namespace: string;
  key: string;
  found: boolean;
  value?: unknown;
  updatedAt?: number;
};

export type RemoteKvWriteResult = {
  scope: RemoteKvScope;
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: number;
};

export type RemoteKvDeleteResult = {
  scope: RemoteKvScope;
  namespace: string;
  key: string;
  deleted: boolean;
  updatedAt?: number;
};

export type RemoteKvStoreInput = {
  scope: RemoteKvScope;
  namespace: string;
  key: string;
  keyId: string;
};

export interface RemoteKvStore {
  read(input: RemoteKvStoreInput): Promise<RemoteKvReadResult>;
  write(input: RemoteKvStoreInput & { value: unknown }): Promise<RemoteKvWriteResult>;
  delete(input: RemoteKvStoreInput): Promise<RemoteKvDeleteResult>;
}

const StoredRemoteKvValueSchema = Type.Object({
  value: Type.Unknown(),
  updatedAt: Type.Number(),
});

const StoredRemoteKvNamespaceSchema = Type.Record(Type.String(), StoredRemoteKvValueSchema);

const StoredRemoteKvScopeSchema = Type.Record(Type.String(), StoredRemoteKvNamespaceSchema);

export const RemoteKvStorageFileSchema = Type.Object({
  version: Type.Literal(1),
  global: StoredRemoteKvScopeSchema,
  users: Type.Record(Type.String(), StoredRemoteKvScopeSchema),
});

export type StoredRemoteKvNamespace = Static<typeof StoredRemoteKvNamespaceSchema>;
export type StoredRemoteKvScope = Static<typeof StoredRemoteKvScopeSchema>;
export type RemoteKvStorageFile = Static<typeof RemoteKvStorageFileSchema>;

export function createEmptyRemoteKvStorageFile(): RemoteKvStorageFile {
  return {
    version: 1,
    global: {},
    users: {},
  };
}

export function resolveStoredNamespace(
  state: RemoteKvStorageFile,
  input: RemoteKvStoreInput,
  createIfMissing: boolean,
): StoredRemoteKvNamespace | undefined {
  const scopeStore = resolveStoredScope(state, input.scope, input.keyId, createIfMissing);
  if (scopeStore === undefined) {
    return undefined;
  }

  const namespace = scopeStore[input.namespace];
  if (namespace !== undefined) {
    return namespace;
  }
  if (!createIfMissing) {
    return undefined;
  }

  const created: StoredRemoteKvNamespace = {};
  scopeStore[input.namespace] = created;
  return created;
}

function resolveStoredScope(
  state: RemoteKvStorageFile,
  scope: RemoteKvScope,
  keyId: string,
  createIfMissing: boolean,
): StoredRemoteKvScope | undefined {
  if (scope === "global") {
    return state.global;
  }

  const existing = state.users[keyId];
  if (existing !== undefined) {
    return existing;
  }
  if (!createIfMissing) {
    return undefined;
  }

  const created: StoredRemoteKvScope = {};
  state.users[keyId] = created;
  return created;
}
