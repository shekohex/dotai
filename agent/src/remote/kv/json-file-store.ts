import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import {
  RemoteKvStorageFileSchema,
  createEmptyRemoteKvStorageFile,
  resolveStoredNamespace,
  type RemoteKvDeleteResult,
  type RemoteKvReadResult,
  type RemoteKvStore,
  type RemoteKvStoreInput,
  type RemoteKvStorageFile,
  type RemoteKvWriteResult,
} from "./store.js";

const noop = () => {};

export class JsonFileRemoteKvStore implements RemoteKvStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private loadedState: RemoteKvStorageFile | undefined;
  private loadTask: Promise<RemoteKvStorageFile> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string; now?: () => number }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
  }

  async read(input: RemoteKvStoreInput): Promise<RemoteKvReadResult> {
    const state = await this.ensureLoadedState();
    const namespace = resolveStoredNamespace(state, input, false);
    const stored = namespace?.[input.key];
    if (stored === undefined) {
      return {
        scope: input.scope,
        namespace: input.namespace,
        key: input.key,
        found: false,
      };
    }

    return {
      scope: input.scope,
      namespace: input.namespace,
      key: input.key,
      found: true,
      value: stored.value,
      updatedAt: stored.updatedAt,
    };
  }

  write(input: RemoteKvStoreInput & { value: unknown }): Promise<RemoteKvWriteResult> {
    return this.enqueueMutation(async () => {
      const state = await this.ensureLoadedState();
      const namespace = resolveStoredNamespace(state, input, true);
      if (namespace === undefined) {
        throw new TypeError("Remote KV namespace is not available");
      }

      const updatedAt = this.now();
      namespace[input.key] = {
        value: input.value,
        updatedAt,
      };
      await this.persistState(state);

      return {
        scope: input.scope,
        namespace: input.namespace,
        key: input.key,
        value: input.value,
        updatedAt,
      };
    });
  }

  delete(input: RemoteKvStoreInput): Promise<RemoteKvDeleteResult> {
    return this.enqueueMutation(async () => {
      const state = await this.ensureLoadedState();
      const namespace = resolveStoredNamespace(state, input, false);
      const stored = namespace?.[input.key];
      if (namespace === undefined || stored === undefined) {
        return {
          scope: input.scope,
          namespace: input.namespace,
          key: input.key,
          deleted: false,
        };
      }

      delete namespace[input.key];
      const updatedAt = this.now();
      await this.persistState(state);
      return {
        scope: input.scope,
        namespace: input.namespace,
        key: input.key,
        deleted: true,
        updatedAt,
      };
    });
  }

  private async ensureLoadedState(): Promise<RemoteKvStorageFile> {
    if (this.loadedState !== undefined) {
      return this.loadedState;
    }
    if (this.loadTask !== undefined) {
      return this.loadTask;
    }

    const task = this.loadStateFromDisk().finally(() => {
      if (this.loadTask === task) {
        this.loadTask = undefined;
      }
    });
    this.loadTask = task;
    this.loadedState = await task;
    return this.loadedState;
  }

  private async loadStateFromDisk(): Promise<RemoteKvStorageFile> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return createEmptyRemoteKvStorageFile();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TypeError(`Invalid remote KV JSON at ${this.filePath}`);
    }

    if (!Value.Check(RemoteKvStorageFileSchema, parsed)) {
      throw new TypeError(`Invalid remote KV schema at ${this.filePath}`);
    }

    return Value.Parse(RemoteKvStorageFileSchema, parsed);
  }

  private async persistState(state: RemoteKvStorageFile): Promise<void> {
    this.loadedState = state;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state), "utf8");
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(noop, noop);
    return result;
  }
}
