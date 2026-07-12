/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/strict-boolean-expressions */
import { isReflectCall } from "../utils/ast-helpers.mjs";
import { getRelativeFilename, isAllowlistedFile, normalizeAllowlist } from "../utils/filename.mjs";
import { readRuleOptions } from "../utils/options.mjs";

const defaultAllowFiles = [
  "src/extensions/bundled-resources.ts",
  "src/extensions/herdr-integration-conflicts.ts",
  "src/extensions/model-family-system-prompt.ts",
];

function createNoReflectOutsideAllowlistRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow Reflect usage outside explicit boundary helpers.",
      },
      schema: [
        {
          type: "object",
          properties: {
            allowFiles: {
              type: "array",
              items: { type: "string" },
            },
          },
          additionalProperties: false,
        },
      ],
    },
    createOnce(context) {
      const options = readRuleOptions(context);
      const allowFiles = normalizeAllowlist([...defaultAllowFiles, ...(options.allowFiles ?? [])]);
      let currentFilename = "<unknown>";

      return {
        before() {
          currentFilename = getRelativeFilename(context);
        },
        CallExpression(node) {
          if (
            isAllowlistedFile({ ...context, filename: currentFilename }, allowFiles) ||
            !isReflectCall(node)
          ) {
            return;
          }
          context.report({
            node,
            message:
              "Reflect access is restricted to small boundary helpers only. This file should use normal typed property access instead. Fix: replace Reflect.get/set/... with direct typed access, or move unavoidable upstream-private access into an explicitly approved boundary helper file.",
          });
        },
      };
    },
  };
}

export { createNoReflectOutsideAllowlistRule };
