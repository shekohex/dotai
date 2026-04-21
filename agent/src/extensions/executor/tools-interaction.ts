import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { JsonObject } from "./http.js";
import type { ResumeAction } from "./mcp-client.js";
import { parseJsonContent } from "./executor-adapter.js";
import { openBrowserTarget } from "./browser.js";
import { isJsonObject, resolveResumeAction } from "./tools-shared.js";

const hasSchemaProperties = (schema: JsonObject | undefined): boolean => {
  if (schema === undefined) {
    return false;
  }

  const properties = schema.properties;
  return isJsonObject(properties) && Object.keys(properties).length > 0;
};

const buildSchemaTemplate = (schema: JsonObject | undefined): JsonObject => {
  if (schema === undefined) {
    return {};
  }

  const properties = schema.properties;
  if (!isJsonObject(properties)) {
    return {};
  }

  const template: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonObject(value)) {
      continue;
    }

    const valueType = typeof value.type === "string" ? value.type : undefined;
    if (valueType === "boolean") {
      template[key] = false;
      continue;
    }

    if (valueType === "number" || valueType === "integer") {
      template[key] = 0;
      continue;
    }

    if (valueType === "array") {
      template[key] = [];
      continue;
    }

    if (valueType === "object") {
      template[key] = {};
      continue;
    }

    template[key] = "";
  }

  return template;
};

const promptForBrowserInteraction = async (
  url: string,
  ctx: ExtensionContext,
): Promise<{ action: ResumeAction }> => {
  try {
    await openBrowserTarget(url);
    ctx.ui.notify(`Opened ${url}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Open this URL manually: ${url}\n\n${message}`, "warning");
  }

  const action = await ctx.ui.select(
    "Executor browser interaction",
    ["accept", "decline", "cancel"],
    { timeout: undefined },
  );
  return { action: resolveResumeAction(action) };
};

export const promptForInteraction = async (
  interaction: {
    mode: "form" | "url";
    message: string;
    requestedSchema?: JsonObject;
    url?: string;
  },
  ctx: ExtensionContext,
): Promise<{ action: ResumeAction; content?: JsonObject }> => {
  if (interaction.mode === "url" && interaction.url !== undefined && interaction.url.length > 0) {
    return promptForBrowserInteraction(interaction.url, ctx);
  }

  if (!hasSchemaProperties(interaction.requestedSchema)) {
    const action = await ctx.ui.select("Executor interaction", ["accept", "decline", "cancel"], {
      timeout: undefined,
    });
    return { action: resolveResumeAction(action) };
  }

  ctx.ui.notify(interaction.message, "info");
  const prefill = JSON.stringify(buildSchemaTemplate(interaction.requestedSchema), null, 2);
  const edited = await ctx.ui.editor("Executor response JSON", prefill);
  if (edited === undefined) {
    return { action: "cancel" };
  }

  const action = await ctx.ui.select("Submit Executor response", ["accept", "decline", "cancel"], {
    timeout: undefined,
  });
  const resolvedAction = resolveResumeAction(action);
  if (resolvedAction !== "accept") {
    return { action: resolvedAction };
  }

  return {
    action: resolvedAction,
    content: parseJsonContent(edited),
  };
};
