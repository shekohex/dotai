import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export function readRemotePrivateKey(options: {
  privateKey?: string;
  privateKeyPath?: string;
}): Promise<string> {
  if (options.privateKey !== undefined && options.privateKey.trim().length > 0) {
    return Promise.resolve(options.privateKey);
  }
  if (options.privateKeyPath !== undefined && options.privateKeyPath.length > 0) {
    return readFile(options.privateKeyPath, "utf8");
  }
  throw new Error("Missing PI_REMOTE_PRIVATE_KEY or PI_REMOTE_PRIVATE_KEY_PATH");
}

export function createInProcessFetch(app: {
  request: (input: string, init?: RequestInit) => Promise<Response>;
}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let requestUrl: URL;
    if (typeof input === "string") {
      requestUrl = new URL(input);
    } else if (input instanceof URL) {
      requestUrl = input;
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url);
    } else {
      throw new TypeError("Unsupported RequestInfo input for in-process fetch");
    }
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    return app.request(path, init);
  }) as typeof fetch;
}

export function defaultSessionNameFromCwd(cwd: string): string {
  return basename(cwd) || "Remote Session";
}
