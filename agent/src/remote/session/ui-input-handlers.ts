import type { RemoteUiInputHandlers } from "./types.js";
import type { RemoteUiContextInput } from "./ui-context-types.js";
import { requestRemoteUiValue } from "./ui-requests.js";

export function createRemoteUiInputHandlers(input: RemoteUiContextInput): RemoteUiInputHandlers {
  return {
    select: (title, options, opts) => selectRemoteUiInput(input, title, options, opts),
    confirm: (title, message, opts) => confirmRemoteUiInput(input, title, message, opts),
    input: (title, placeholder, opts) => inputRemoteUiInput(input, title, placeholder, opts),
    editor: (title, prefill) => editorRemoteUiInput(input, title, prefill),
    custom: () => Promise.reject(new Error("Custom UI requests are not supported in remote mode")),
  };
}

function selectRemoteUiInput(
  input: RemoteUiContextInput,
  title: string,
  options: string[],
  opts: { timeout?: number; signal?: AbortSignal } | undefined,
): Promise<string | undefined> {
  return requestRemoteUiValue(
    input.record,
    {
      method: "select",
      title,
      options,
      timeout: opts?.timeout,
      signal: opts?.signal,
      defaultValue: undefined,
      parse: (response) => ("value" in response ? response.value : undefined),
    },
    input,
  );
}

function confirmRemoteUiInput(
  input: RemoteUiContextInput,
  title: string,
  message: string,
  opts: { timeout?: number; signal?: AbortSignal } | undefined,
): Promise<boolean> {
  return requestRemoteUiValue(
    input.record,
    {
      method: "confirm",
      title,
      message,
      timeout: opts?.timeout,
      signal: opts?.signal,
      defaultValue: false,
      parse: (response) => ("confirmed" in response ? response.confirmed : false),
    },
    input,
  );
}

function inputRemoteUiInput(
  input: RemoteUiContextInput,
  title: string,
  placeholder: string | undefined,
  opts: { timeout?: number; signal?: AbortSignal } | undefined,
): Promise<string | undefined> {
  return requestRemoteUiValue(
    input.record,
    {
      method: "input",
      title,
      placeholder,
      timeout: opts?.timeout,
      signal: opts?.signal,
      defaultValue: undefined,
      parse: (response) => ("value" in response ? response.value : undefined),
    },
    input,
  );
}

function editorRemoteUiInput(
  input: RemoteUiContextInput,
  title: string,
  prefill: string | undefined,
): Promise<string | undefined> {
  return requestRemoteUiValue(
    input.record,
    {
      method: "editor",
      title,
      prefill,
      defaultValue: undefined,
      parse: (response) => ("value" in response ? response.value : undefined),
    },
    input,
  );
}
