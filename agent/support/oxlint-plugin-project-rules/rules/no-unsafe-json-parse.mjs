/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/strict-boolean-expressions */
function isJsonParseCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "JSON" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "parse"
  );
}

function createNoUnsafeJsonParseRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Require JSON.parse results to stay unknown until validated.",
      },
      schema: [],
    },
    createOnce(context) {
      return {
        TSAsExpression(node) {
          if (!isJsonParseCall(node.expression)) {
            return;
          }
          if (node.typeAnnotation?.type === "TSUnknownKeyword") {
            return;
          }
          context.report({
            node,
            message:
              "`JSON.parse(...)` result must stay `unknown` until validated. Do not cast parsed JSON directly to a structured type. Fix: assign parse result to `unknown`, then validate with `Value.Check(...)` / `Value.Parse(...)` or a dedicated safe parser before using structured fields.",
          });
        },
        VariableDeclarator(node) {
          if (!isJsonParseCall(node.init) || node.id?.type !== "Identifier") {
            return;
          }
          const annotation = node.id.typeAnnotation?.typeAnnotation;
          if (annotation && annotation.type !== "TSUnknownKeyword") {
            context.report({
              node,
              message:
                "Variable initialized from `JSON.parse(...)` should be typed as `unknown` first. Fix: change this declaration to `const parsed: unknown = JSON.parse(...)`, then validate before using it as structured data.",
            });
          }
        },
      };
    },
  };
}

export { createNoUnsafeJsonParseRule };
