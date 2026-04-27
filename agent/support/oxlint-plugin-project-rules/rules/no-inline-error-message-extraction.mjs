/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/strict-boolean-expressions */
import { getRelativeFilename } from "../utils/filename.mjs";

function isErrorMessageTernary(node) {
  return (
    node?.type === "ConditionalExpression" &&
    node.test?.type === "BinaryExpression" &&
    node.test.operator === "instanceof" &&
    node.test.right?.type === "Identifier" &&
    node.test.right.name === "Error" &&
    node.test.left?.type === "Identifier" &&
    node.consequent?.type === "MemberExpression" &&
    !node.consequent.computed &&
    node.consequent.object?.type === "Identifier" &&
    node.consequent.object.name === node.test.left.name &&
    node.consequent.property?.type === "Identifier" &&
    node.consequent.property.name === "message" &&
    node.alternate?.type === "CallExpression" &&
    node.alternate.callee?.type === "Identifier" &&
    node.alternate.callee.name === "String" &&
    node.alternate.arguments?.[0]?.type === "Identifier" &&
    node.alternate.arguments[0].name === node.test.left.name
  );
}

function isSharedErrorHelper(node) {
  const parent = node?.parent;
  const returnStatement = parent?.type === "ReturnStatement" ? parent : undefined;
  const blockStatement =
    returnStatement?.parent?.type === "BlockStatement" ? returnStatement.parent : undefined;
  const functionNode = blockStatement?.parent;
  if (functionNode?.type !== "FunctionDeclaration" && functionNode?.type !== "FunctionExpression") {
    return false;
  }
  return functionNode.id?.type === "Identifier" && /errormessage/i.test(functionNode.id.name);
}

function createNoInlineErrorMessageExtractionRule() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description: "Disallow repeated inline error-to-string ternaries.",
      },
      schema: [],
    },
    createOnce(context) {
      return {
        ConditionalExpression(node) {
          const relativeFilename = getRelativeFilename(context);
          if (!isErrorMessageTernary(node)) {
            return;
          }
          if (relativeFilename.endsWith("/error-message.ts") || isSharedErrorHelper(node)) {
            return;
          }
          context.report({
            node,
            message:
              "This inline `error instanceof Error ? error.message : String(error)` pattern is duplicated logic. Fix: move error-to-string conversion into a small shared helper and call that helper here, so error formatting stays consistent across the project.",
          });
        },
      };
    },
  };
}

export { createNoInlineErrorMessageExtractionRule };
