/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument */
import { getRelativeFilename } from "../utils/filename.mjs";

const helperNames = new Set([
  "asRecord",
  "isRecord",
  "readString",
  "readNumber",
  "readDeepString",
  "readDeepNumber",
]);

const sharedHelperFiles = new Set([
  "src/utils/unknown-data.ts",
  "src/extensions/openusage/providers/shared.ts",
]);

function createNoLocalUnknownRecordHelperRule() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description: "Disallow local redefinition of repeated unknown-record helpers.",
      },
      schema: [],
    },
    createOnce(context) {
      function isSharedHelperFile() {
        const relativeFilename = getRelativeFilename(context);
        return sharedHelperFiles.has(relativeFilename);
      }

      function shouldReport(node, name) {
        if (isSharedHelperFile()) {
          return false;
        }
        if (!helperNames.has(name)) {
          return false;
        }
        const firstParameter = node.params?.[0];
        return (
          firstParameter?.type === "Identifier" &&
          firstParameter.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword"
        );
      }

      function report(node, name) {
        context.report({
          node,
          message: `Local helper \`${name}(value: unknown)\` repeats a boundary-parsing pattern that already appears across the repo. Fix: extract and reuse a shared helper module instead of redefining another local unknown-record/string/number reader here.`,
        });
      }

      return {
        FunctionDeclaration(node) {
          if (node.id?.type !== "Identifier" || !shouldReport(node, node.id.name)) {
            return;
          }
          report(node, node.id.name);
        },
        VariableDeclarator(node) {
          if (
            node.id?.type !== "Identifier" ||
            !helperNames.has(node.id.name) ||
            (node.init?.type !== "ArrowFunctionExpression" &&
              node.init?.type !== "FunctionExpression")
          ) {
            return;
          }
          if (!shouldReport(node.init, node.id.name)) {
            return;
          }
          report(node, node.id.name);
        },
      };
    },
  };
}

export { createNoLocalUnknownRecordHelperRule };
