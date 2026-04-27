/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access */
import { isGlobalFetchCall } from "../utils/ast-helpers.mjs";

function createNoDirectFetchInRemoteRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow direct fetch inside remote code.",
      },
      schema: [],
    },
    createOnce(context) {
      return {
        CallExpression(node) {
          if (!isGlobalFetchCall(node)) {
            return;
          }
          context.report({
            node,
            message:
              "Direct fetch is forbidden inside remote/ code. Use typed Hono RPC client/server paths instead so transport stays consistent, validated, and refactor-safe. Fix: move this call behind existing Hono RPC route/client helpers, or add a typed RPC endpoint instead of calling fetch directly.",
          });
        },
      };
    },
  };
}

export { createNoDirectFetchInRemoteRule };
