import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";

type DetachedGsdJobConfig<TResult> = {
  startMessage: string;
  successMessage?: string | ((result: TResult) => string);
  failureMessage: string | ((error: unknown) => string);
  onSuccess?: (result: TResult) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
};

export function runDetachedGsdJob<TResult>(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  job: () => Promise<TResult>,
  config: DetachedGsdJobConfig<TResult>,
): void {
  ctx.ui.notify(config.startMessage, "info");

  void (async () => {
    try {
      const result = await job();
      await config.onSuccess?.(result);
      const successMessage =
        typeof config.successMessage === "function"
          ? config.successMessage(result)
          : config.successMessage;
      if (successMessage !== undefined && successMessage.length > 0) {
        ctx.ui.notify(successMessage, "info");
      }
    } catch (error) {
      await config.onFailure?.(error);
      const failureMessage =
        typeof config.failureMessage === "function"
          ? config.failureMessage(error)
          : config.failureMessage;
      ctx.ui.notify(failureMessage, "error");
    }
  })();
}

export function formatDetachedGsdFailure(prefix: string, error: unknown): string {
  return `${prefix}: ${errorMessage(error)}`;
}
