/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions */
import {
  createLocalTypeTracker,
  isRedundantArrayIsArrayCall,
  isRedundantInCheck,
  isRedundantTypeofCheck,
} from "../utils/local-type-helpers.mjs";
import { getRelativeFilename, isAllowlistedFile, normalizeAllowlist } from "../utils/filename.mjs";
import { readRuleOptions } from "../utils/options.mjs";

const supportedChecks = new Set(["array", "in", "typeof"]);
const defaultAllowFiles = [
  "src/extensions/subagent/render-state.ts",
  "src/extensions/modes/events.ts",
];

function normalizeChecks(value) {
  if (!Array.isArray(value)) {
    return new Set(supportedChecks);
  }
  const checks = value.filter((entry) => typeof entry === "string" && supportedChecks.has(entry));
  return new Set(checks.length > 0 ? checks : supportedChecks);
}

function createNoRedundantRuntimeNarrowingRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow runtime narrowing that TypeScript already proves locally.",
      },
      schema: [
        {
          type: "object",
          properties: {
            allowFiles: {
              type: "array",
              items: { type: "string" },
            },
            checks: {
              type: "array",
              items: {
                enum: ["array", "in", "typeof"],
              },
            },
          },
          additionalProperties: false,
        },
      ],
    },
    createOnce(context) {
      const options = readRuleOptions(context);
      const allowFiles = normalizeAllowlist([...defaultAllowFiles, ...(options.allowFiles ?? [])]);
      const enabledChecks = normalizeChecks(options.checks);
      const tracker = createLocalTypeTracker();
      let currentFilename = "<unknown>";

      function isAllowedFile() {
        return isAllowlistedFile({ ...context, filename: currentFilename }, allowFiles);
      }

      return {
        Program(node) {
          currentFilename = getRelativeFilename(context);
          tracker.registerProgram(node);
          tracker.enterScope();
        },
        "Program:exit"() {
          tracker.exitScope();
        },
        BlockStatement() {
          tracker.enterScope();
        },
        "BlockStatement:exit"() {
          tracker.exitScope();
        },
        FunctionDeclaration(node) {
          tracker.enterScope();
          tracker.registerFunctionParameters(node);
        },
        "FunctionDeclaration:exit"() {
          tracker.exitScope();
        },
        FunctionExpression(node) {
          tracker.enterScope();
          tracker.registerFunctionParameters(node);
        },
        "FunctionExpression:exit"() {
          tracker.exitScope();
        },
        ArrowFunctionExpression(node) {
          tracker.enterScope();
          tracker.registerFunctionParameters(node);
        },
        "ArrowFunctionExpression:exit"() {
          tracker.exitScope();
        },
        VariableDeclarator(node) {
          tracker.registerVariableDeclarator(node);
        },
        BinaryExpression(node) {
          if (isAllowedFile()) {
            return;
          }
          if (enabledChecks.has("typeof") && isRedundantTypeofCheck(node, tracker)) {
            context.report({
              node,
              message:
                "This runtime `typeof` check is redundant. TypeScript already proves this identifier has that type in this file. Fix: remove the check and use the value directly. If this value truly crosses an untyped boundary, keep it as `unknown` until validated instead of annotating it first and narrowing it again.",
            });
            return;
          }
          if (enabledChecks.has("in") && isRedundantInCheck(node, tracker)) {
            context.report({
              node,
              message:
                "This `in` check is redundant. TypeScript already proves this required property exists on this identifier in this file. Fix: remove the check and access the property directly. If this value is really dynamic input, keep it `unknown` and validate at boundary instead of narrowing a pre-typed value.",
            });
          }
        },
        CallExpression(node) {
          if (isAllowedFile()) {
            return;
          }
          if (enabledChecks.has("array") && isRedundantArrayIsArrayCall(node, tracker)) {
            context.report({
              node,
              message:
                "This `Array.isArray(...)` check is redundant. TypeScript already proves this identifier is an array in this file. Fix: remove the check and use the array directly. If this value is external input, keep it `unknown` until validated at boundary.",
            });
          }
        },
      };
    },
  };
}

export { createNoRedundantRuntimeNarrowingRule };
