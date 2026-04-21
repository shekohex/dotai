import {
  createEmptyRemoteKvStorageFile,
  resolveStoredNamespace,
  type RemoteKvDeleteResult,
  type RemoteKvReadResult,
  type RemoteKvStore,
  type RemoteKvStoreInput,
  type RemoteKvStorageFile,
  type RemoteKvWriteResult,
} from "./store.js";

export class InMemoryRemoteKvStore implements RemoteKvStore {
  private readonly state: RemoteKvStorageFile = createEmptyRemoteKvStorageFile();
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => Date.now());
  }

  read(input: RemoteKvStoreInput): Promise<RemoteKvReadResult> {
    const namespace = resolveStoredNamespace(this.state, input, false);
    const stored = namespace?.[input.key];
    if (stored === undefined) {
      return Promise.resolve({
        scope: input.scope,
        namespace: input.namespace,
        key: input.key,
        found: false,
      });
    }

    return Promise.resolve({
      scope: input.scope,
      namespace: input.namespace,
      key: input.key,
      found: true,
      value: stored.value,
      updatedAt: stored.updatedAt,
    });
  }

  write(input: RemoteKvStoreInput & { value: unknown }): Promise<RemoteKvWriteResult> {
    const namespace = resolveStoredNamespace(this.state, input, true);
    if (namespace === undefined) {
      throw new TypeError("Remote KV namespace is not available");
    }
    const updatedAt = this.now();
    namespace[input.key] = {
      value: input.value,
      updatedAt,
    };
    return Promise.resolve({
      scope: input.scope,
      namespace: input.namespace,
      key: input.key,
      value: input.value,
      updatedAt,
    });
  }

  delete(input: RemoteKvStoreInput): Promise<RemoteKvDeleteResult> {
    const namespace = resolveStoredNamespace(this.state, input, false);
    const stored = namespace?.[input.key];
    if (namespace === undefined || stored === undefined) {
      return Promise.resolve({
        scope: input.scope,
        namespace: input.namespace,
        key: input.key,
        deleted: false,
      });
    }

    delete namespace[input.key];
    return Promise.resolve({
      scope: input.scope,
      namespace: input.namespace,
      key: input.key,
      deleted: true,
      updatedAt: this.now(),
    });
  }
}
