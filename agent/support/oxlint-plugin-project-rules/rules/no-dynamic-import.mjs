/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/strict-boolean-expressions */
import { getRelativeFilename, isAllowlistedFile, normalizeAllowlist } from "../utils/filename.mjs";
import { readRuleOptions } from "../utils/options.mjs";

const defaultAllowFiles = ["bin/pi.js"];

function createNoDynamicImportRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow dynamic import() in project source.",
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
        ImportExpression(node) {
          if (isAllowlistedFile({ ...context, filename: currentFilename }, allowFiles)) {
            return;
          }
          context.report({
            node,
            message:
              "Dynamic import() is forbidden here. Move import to top level so module loading stays static, types stay visible, and bundling/runtime behavior stays predictable. Fix: replace import(...) with a normal top-level import or split code into a module imported at file scope.",
          });
        },
      };
    },
  };
}

export { createNoDynamicImportRule };
